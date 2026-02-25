import os
from supabase import create_client, Client
from datetime import date
from dotenv import load_dotenv
import pandas as pd

# Cargar variables de entorno
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
            "password_hash": password,  # <-- CAMBIADO: era "password", ahora "password_hash"
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

# --- HELPER: BUSCAR HERMANO EN HISTORIAL PARA FUSIONAR ---
def find_sibling_in_history(username, symbol, entry_date, entry_price):
    """Busca si ya existe un cierre parcial previo para fusionar datos."""
    try:
        # Buscamos por usuario, simbolo, fecha de entrada y precio de entrada (para diferenciar trades del mismo activo)
        res = supabase.table("trades").select("*")\
            .eq("username", username)\
            .eq("symbol", symbol)\
            .eq("entry_date", str(entry_date))\
            .eq("entry_price", float(entry_price))\
            .eq("status", "CLOSED")\
            .execute()
        
        if res.data and len(res.data) > 0:
            return res.data[0] # Retorna el trade encontrado
        return None
    except Exception as e:
        print(f"Error buscando sibling: {e}")
        return None

def close_trade_total(trade_id, exit_price, exit_date, result_type, exit_notes=""):
    try:
        # 1. Obtener datos del trade activo
        res = supabase.table("trades").select("*").eq("id", trade_id).execute()
        if not res.data: return False
        trade = res.data[0]
        
        # Datos actuales
        entry_price = float(trade['entry_price'])
        current_qty = int(trade['quantity'])
        side = trade['side'].upper()
        sl = float(trade['initial_stop_loss'])
        username = trade['username']
        symbol = trade['symbol']
        entry_date = trade['entry_date']

        # 2. Calcular PnL de ESTA porción
        if side == 'LONG':
            pnl_chunk = (float(exit_price) - entry_price) * current_qty
        else:
            pnl_chunk = (entry_price - float(exit_price)) * current_qty

        # 3. Buscar si hay historial previo para fusionar (Promedio Ponderado)
        sibling = find_sibling_in_history(username, symbol, entry_date, entry_price)

        if sibling:
            # --- LOGICA DE FUSION (MERGE) ---
            sib_id = sibling['id']
            sib_qty = int(sibling['quantity'])
            sib_exit_price = float(sibling['exit_price'])
            sib_pnl = float(sibling['pnl'])
            sib_notes = sibling.get('exit_notes', "") or ""

            # Matemáticas de promedio ponderado
            total_qty = sib_qty + current_qty
            total_pnl = sib_pnl + pnl_chunk
            
            # Precio promedio salida = ((Precio Viejo * Qty Vieja) + (Precio Nuevo * Qty Nueva)) / Total
            avg_exit_price = ((sib_exit_price * sib_qty) + (float(exit_price) * current_qty)) / total_qty
            
            # Recalcular RR global
            if sl != 0 and sl != entry_price:
                risk_per_share = abs(entry_price - sl)
                total_risk = risk_per_share * total_qty
                new_rr = total_pnl / total_risk if total_risk > 0 else 0
            else:
                new_rr = 0
            
            # Concatenar notas si son diferentes
            new_notes = sib_notes
            if exit_notes and exit_notes not in sib_notes:
                new_notes = f"{sib_notes} | {exit_notes}".strip(" | ")

            # Actualizar el historial existente
            data_update = {
                "quantity": total_qty,
                "exit_price": round(avg_exit_price, 2),
                "pnl": round(total_pnl, 2),
                "rr": round(new_rr, 2),
                "exit_date": str(exit_date), # Actualizamos a la ultima fecha de cierre
                "exit_notes": new_notes,
                "result_type": result_type # Actualizamos con el resultado final
            }
            supabase.table("trades").update(data_update).eq("id", sib_id).execute()
            
            # ELIMINAR el trade activo (porque ya lo fusionamos con el historial)
            supabase.table("trades").delete().eq("id", trade_id).execute()
            
        else:
            # --- CIERRE NORMAL (NO EXISTE HISTORIAL PREVIO) ---
            if sl != 0 and sl != entry_price:
                risk = abs(entry_price - sl) * current_qty
                rr = pnl_chunk / risk if risk > 0 else 0
            else:
                rr = 0
            
            data = {
                "exit_price": float(exit_price),
                "exit_date": str(exit_date),
                "result_type": result_type,
                "pnl": round(pnl_chunk, 2),
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
    Cierra parcial fusionando con historial si existe.
    """
    try:
        # 1. Obtener trade original
        res = supabase.table("trades").select("*").eq("id", trade_id).execute()
        if not res.data: return False, "Trade no encontrado"
        trade = res.data[0]
        
        current_qty = int(trade['quantity'])
        partial_qty = int(partial_qty)
        
        # Si cerramos todo o mas de lo que hay, usar la funcion de cierre total
        if partial_qty >= current_qty:
            return close_trade_total(trade_id, exit_price, exit_date, "WIN", "") # El resultado se recalcula adentro

        # Datos trade
        entry_price = float(trade['entry_price'])
        side = trade['side'].upper()
        sl = float(trade['initial_stop_loss'])
        username = trade['username']
        symbol = trade['symbol']
        entry_date = trade['entry_date']

        # 2. Calcular PnL de ESTA porción parcial
        if side == 'LONG':
            pnl_chunk = (float(exit_price) - entry_price) * partial_qty
        else:
            pnl_chunk = (entry_price - float(exit_price)) * partial_qty

        # Resultado de este chunk
        if pnl_chunk > 0: r_type = 'WIN'
        elif pnl_chunk < 0: r_type = 'LOSS'
        else: r_type = 'BE'

        # 3. Buscar hermano en historial para fusionar
        sibling = find_sibling_in_history(username, symbol, entry_date, entry_price)

        if sibling:
            # --- FUSIONAR CON HISTORIAL EXISTENTE ---
            sib_id = sibling['id']
            sib_qty = int(sibling['quantity'])
            sib_exit_price = float(sibling['exit_price'])
            sib_pnl = float(sibling['pnl'])

            # Matematicas
            new_total_qty = sib_qty + partial_qty
            new_total_pnl = sib_pnl + pnl_chunk
            new_avg_exit = ((sib_exit_price * sib_qty) + (float(exit_price) * partial_qty)) / new_total_qty

            # RR
            if sl != 0 and sl != entry_price:
                risk_per_share = abs(entry_price - sl)
                total_risk = risk_per_share * new_total_qty
                new_rr = new_total_pnl / total_risk if total_risk > 0 else 0
            else:
                new_rr = 0

            update_data = {
                "quantity": new_total_qty,
                "exit_price": round(new_avg_exit, 2),
                "pnl": round(new_total_pnl, 2),
                "rr": round(new_rr, 2),
                "exit_date": str(exit_date),
                "result_type": r_type if new_total_pnl > 0 else 'LOSS' # Actualizar estado global
            }
            supabase.table("trades").update(update_data).eq("id", sib_id).execute()

        else:
            # --- CREAR NUEVO REGISTRO HISTORICO (PRIMER PARCIAL) ---
            if sl != 0 and sl != entry_price:
                risk_per_share = abs(entry_price - sl)
                risk_chunk = risk_per_share * partial_qty
                rr_chunk = pnl_chunk / risk_chunk if risk_chunk > 0 else 0
            else:
                rr_chunk = 0

            new_row = trade.copy()
            if "id" in new_row: del new_row["id"]
            if "created_at" in new_row: del new_row["created_at"]
            
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

        # 4. ACTUALIZAR EL TRADE ACTIVO (RESTAR CANTIDAD)
        remaining_qty = current_qty - partial_qty
        supabase.table("trades").update({"quantity": remaining_qty}).eq("id", trade_id).execute()

        return True, "Parcial ejecutado y fusionado"

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
