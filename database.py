import os
from supabase import create_client, Client
from datetime import date
from dotenv import load_dotenv
import pandas as pd

load_dotenv()

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")

if not url or not key:
    raise ValueError("Faltan credenciales de Supabase en .env")

supabase: Client = create_client(url, key)

def init_db():
    pass

def get_user(username):
    try:
        response = supabase.table("users").select("*").eq("username", username).execute()
        if response.data:
            return response.data[0]
        return None
    except Exception as e:
        print(f"Error get_user: {e}")
        return None

def register_user(username, password, full_name):
    try:
        if get_user(username):
            return False, "Usuario ya existe"
        data = {
            "username": username,
            "password_hash": password,
            "full_name": full_name,
            "config": {}
        }
        supabase.table("users").insert(data).execute()
        return True, "Usuario creado"
    except Exception as e:
        return False, str(e)

def update_user_config(username, new_config):
    try:
        supabase.table("users").update({"config": new_config}).eq("username", username).execute()
        return True
    except Exception as e:
        print(f"Error config: {e}")
        return False

# --- FUNCIONES DE TRADES ---

def open_new_trade(user, symbol, side, price, quantity, date_val, sl, current_sl, tags, entry_notes=""):
    try:
        data = {
            "username": user,
            "symbol": symbol,
            "side": side,
            "entry_price": float(price),
            "quantity": int(quantity),
            "entry_date": str(date_val),
            "initial_stop_loss": float(sl),
            "current_stop_loss": float(current_sl),
            "tags": tags,
            "entry_notes": entry_notes,
            "status": "OPEN"
        }
        res = supabase.table("trades").insert(data).execute()
        return res
    except Exception as e:
        print(f"Error open_trade: {e}")
        return None

def get_open_trades(user):
    try:
        response = supabase.table("trades").select("*").eq("username", user).eq("status", "OPEN").execute()
        return pd.DataFrame(response.data) if response.data else pd.DataFrame()
    except Exception as e:
        print(f"Error get_open: {e}")
        return pd.DataFrame()

def get_closed_trades(user):
    try:
        response = supabase.table("trades").select("*").eq("username", user).eq("status", "CLOSED").execute()
        return pd.DataFrame(response.data) if response.data else pd.DataFrame()
    except Exception as e:
        print(f"Error get_closed: {e}")
        return pd.DataFrame()

def close_trade_total(trade_id, exit_price, exit_date, result_type, exit_notes=""):
    """
    Cierra la totalidad de la cantidad restante del trade activo.
    Cada cierre (parcial o total) queda como un registro CLOSED separado
    con su propia fecha, lo que permite que Performance calcule correctamente
    el cash flow de cada tramo.
    """
    try:
        res = supabase.table("trades").select("*").eq("id", trade_id).execute()
        if not res.data: return False
        trade = res.data[0]

        entry_price = float(trade['entry_price'])
        current_qty = int(trade['quantity'])
        side = trade['side'].upper()
        sl = float(trade['initial_stop_loss'])

        if side == 'LONG':
            pnl = (float(exit_price) - entry_price) * current_qty
        else:
            pnl = (entry_price - float(exit_price)) * current_qty

        if sl != 0 and sl != entry_price:
            risk = abs(entry_price - sl) * current_qty
            rr = pnl / risk if risk > 0 else 0
        else:
            rr = 0

        data = {
            "exit_price": float(exit_price),
            "exit_date": str(exit_date),
            "result_type": result_type,
            "pnl": round(pnl, 2),
            "rr": round(rr, 2),
            "status": "CLOSED",
            "exit_notes": exit_notes
        }
        supabase.table("trades").update(data).eq("id", trade_id).execute()
        return True
    except Exception as e:
        print(f"Error closing total: {e}")
        return False

def close_partial(trade_id, partial_qty, exit_price, exit_date):
    """
    Cierra parcialmente una posición.
    Crea un nuevo registro CLOSED para el tramo cerrado con la fecha correcta
    y reduce la cantidad del trade activo. No fusiona registros, lo que permite
    que Performance vea cada tramo con su fecha real de cierre.
    """
    try:
        res = supabase.table("trades").select("*").eq("id", trade_id).execute()
        if not res.data: return False, "Trade no encontrado"
        trade = res.data[0]

        current_qty = int(trade['quantity'])
        partial_qty = int(partial_qty)

        if partial_qty >= current_qty:
            return close_trade_total(trade_id, exit_price, exit_date, "WIN", ""), ""

        entry_price = float(trade['entry_price'])
        side = trade['side'].upper()
        sl = float(trade['initial_stop_loss'])

        if side == 'LONG':
            pnl_chunk = (float(exit_price) - entry_price) * partial_qty
        else:
            pnl_chunk = (entry_price - float(exit_price)) * partial_qty

        if pnl_chunk > 0: r_type = 'WIN'
        elif pnl_chunk < 0: r_type = 'LOSS'
        else: r_type = 'BE'

        if sl != 0 and sl != entry_price:
            risk_chunk = abs(entry_price - sl) * partial_qty
            rr_chunk = pnl_chunk / risk_chunk if risk_chunk > 0 else 0
        else:
            rr_chunk = 0

        new_row = trade.copy()
        for key in ("id", "created_at"):
            new_row.pop(key, None)

        new_row.update({
            "quantity": partial_qty,
            "exit_price": float(exit_price),
            "exit_date": str(exit_date),
            "pnl": round(pnl_chunk, 2),
            "rr": round(rr_chunk, 2),
            "result_type": r_type,
            "status": "CLOSED"
        })
        supabase.table("trades").insert(new_row).execute()

        supabase.table("trades").update({"quantity": current_qty - partial_qty}).eq("id", trade_id).execute()

        return True, "Parcial ejecutado"
    except Exception as e:
        print(f"Error partial logic: {e}")
        return False, str(e)

def update_stop_loss(trade_id, new_sl):
    try:
        supabase.table("trades").update({"current_stop_loss": float(new_sl)}).eq("id", trade_id).execute()
        return True
    except Exception as e:
        print(f"Error updating SL: {e}")
        return False

def delete_trade(trade_id):
    try:
        supabase.table("trades").delete().eq("id", trade_id).execute()
        return True
    except Exception as e:
        print(f"Error delete: {e}")
        return False

def delete_all_closed_trades(user):
    try:
        supabase.table("trades").delete().eq("username", user).eq("status", "CLOSED").execute()
        return True
    except Exception as e:
        print(f"Error delete all: {e}")
        return False
