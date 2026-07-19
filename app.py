import dash
from dash import dcc, html, Input, Output, State, callback, ctx, no_update, ALL
import dash_bootstrap_components as dbc
import dash_ag_grid as dag
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from datetime import date, datetime, timedelta
import database as db
import base64
import io
import yfinance as yf
import numpy as np
import requests
import re 
from datetime import datetime as dt_datetime

# --- CACHE PARA PRECIOS LIVE (30 segundos) ---
_price_cache = {}
_cache_timestamp = {}
_perf_cache = {}
_perf_cache_time = {}
PERF_CACHE_TTL = 300
# Cache de precios históricos (los cierres pasados no cambian intradía)
_hist_price_cache = {}
_hist_price_cache_time = {}
HIST_CACHE_TTL = 600
# Cache de la serie diaria construida del portfolio (por usuario):
# los cambios de período solo recortan esta serie, no la reconstruyen
_daily_cache = {}
_daily_cache_time = {}
# Cache de series de benchmark (rango completo, se recorta por período)
_bench_cache = {}
_bench_cache_time = {}

def invalidate_perf_caches():
    """Limpia los caches de Performance. Llamar cuando cambian trades o movimientos."""
    _perf_cache.clear()
    _perf_cache_time.clear()
    _daily_cache.clear()
    _daily_cache_time.clear()

def get_cached_live_prices(tickers):
    """Obtiene precios con cache de 30 segundos para evitar descargas repetitivas"""
    now = dt_datetime.now()
    cache_key = tuple(sorted(tickers))
    
    # Verificar si hay cache válido (menos de 30 segundos)
    if cache_key in _price_cache:
        last_update = _cache_timestamp.get(cache_key)
        if last_update and (now - last_update).seconds < 30:
            print(f"[CACHE] ⚡ Usando precios cacheados para {len(tickers)} tickers")
            return _price_cache[cache_key]
    
    # Descargar nuevos precios
    print(f"[DOWNLOAD] 📥 Descargando precios para {len(tickers)} tickers")
    try:
        data = yf.download(tickers, period="1d", progress=False)['Close']
        
        # Guardar en cache
        _price_cache[cache_key] = data
        _cache_timestamp[cache_key] = now
        
        return data
    except Exception as e:
        print(f"[ERROR] ❌ Error descargando precios: {e}")
        # Si hay error pero tenemos cache viejo, usarlo
        if cache_key in _price_cache:
            print(f"[CACHE] ⚠️ Usando cache viejo por error de descarga")
            return _price_cache[cache_key]
        return None

# --- CONFIGURACIÓN DE COLORES QUANT / TERMINAL ---
COLOR_POS = "#00B0BD"      # Teal Neón
COLOR_NEG = "#F6465D"      # Rojo (Pérdidas)
COLOR_NEUTRAL = "#848E9C"  # Gris (BE / Etiquetas)
COLOR_SPY = "#FCD535"      # Amarillo (Highlights sutiles)
BG_COLOR = "#0B0E11"       # Fondo general extra oscuro
CARD_BG = "#181A20"        # Fondo de tarjetas y filas pares
ROW_ODD_BG = "#1E222B"     # Fondo filas impares
BORDER_COLOR = "#2B3139"   # Bordes sutiles grises
TEXT_MAIN = "#EAECEF"      # Texto principal blanco/hielo
EODHD_API_KEY = "demo"

db.init_db()

GOOGLE_FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
app = dash.Dash(__name__, external_stylesheets=[dbc.themes.CYBORG, GOOGLE_FONTS], suppress_callback_exceptions=True)
app.title = "Edge Journal"
server = app.server

# --- ESTILOS MONOSPACE ---
KPI_CARD_STYLE = {
    "textAlign": "center", 
    "border": f"1px solid {BORDER_COLOR}", 
    "backgroundColor": CARD_BG, 
    "borderRadius": "4px", 
    "padding": "18px 10px", 
    "height": "100%", 
    "minWidth": "120px",
    "boxShadow": "0 4px 12px rgba(0,0,0,0.15)",
    "transition": "all 0.3s ease"
}
KPI_VAL_STYLE = {"fontSize": "1.25rem", "fontWeight": "bold", "color": TEXT_MAIN, "margin": "0", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}
KPI_LBL_STYLE = {"fontSize": "0.70rem", "color": COLOR_NEUTRAL, "textTransform": "uppercase", "letterSpacing": "1px", "marginTop": "6px", "fontWeight": "bold", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}
SCROLL_CONTAINER_STYLE = {"overflowX": "auto", "whiteSpace": "nowrap", "paddingBottom": "15px", "scrollbarWidth": "thin"}

TAB_STYLE = {
    "backgroundColor": BG_COLOR, "color": COLOR_NEUTRAL, "border": "none", 
    "borderBottom": f"1px solid {BORDER_COLOR}", "padding": "15px", "fontWeight": "bold", "cursor": "pointer", "fontFamily": "'Inter', 'Segoe UI', sans-serif"
}
TAB_SELECTED_STYLE = {
    "backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": "none",
    "borderBottom": f"3px solid {COLOR_POS}", "padding": "15px", "fontWeight": "bold", "cursor": "pointer", "fontFamily": "'Inter', 'Segoe UI', sans-serif"
}

# Botones de período de Performance: estilo base y activo
PERF_BTN_STYLE = {"fontFamily": "'Inter', 'Segoe UI', sans-serif", "fontWeight": "bold", "borderColor": BORDER_COLOR, "color": COLOR_NEUTRAL}
PERF_BTN_ACTIVE_STYLE = {**PERF_BTN_STYLE, "color": "#000", "backgroundColor": COLOR_POS, "borderColor": COLOR_POS}

# Pestañas del dashboard (los paneles persistentes usan estos ids)
TAB_IDS = ['tab-active', 'tab-history', 'tab-analytics', 'tab-montecarlo', 'tab-performance', 'tab-info']

# --- ESTILO DE GRILLA QUANT ---
CUSTOM_GRID_STYLE = {
    "--ag-background-color": CARD_BG,
    "--ag-header-background-color": BG_COLOR,
    "--ag-header-foreground-color": TEXT_MAIN,
    "--ag-data-color": TEXT_MAIN,
    "--ag-border-color": BORDER_COLOR,             
    "--ag-row-border-color": BORDER_COLOR,
    "--ag-odd-row-background-color": ROW_ODD_BG,    
    "--ag-alpine-active-color": BORDER_COLOR,       
    "--ag-input-focus-border-color": BORDER_COLOR,  
    "--ag-selected-row-background-color": "#2B3139",
    "--ag-row-hover-color": "#252930",              
    "--ag-font-family": "'Inter', 'Segoe UI', sans-serif",
    "--ag-font-size": "13px",
    "--ag-checkbox-checked-color": COLOR_NEUTRAL,
    "--ag-range-selection-border-color": "transparent"
}
INPUT_STYLE = {"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "boxShadow": "none"}
DROPDOWN_STYLE = {"backgroundColor": BG_COLOR, "color": "#000", "border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}

# --- UTILS ---
# Claves del config JSON que no son parámetros de estrategia
RESERVED_CONFIG_KEYS = {'initial_balance', 'currency'}

def cur_sym(conf):
    """Símbolo de moneda de la cuenta según config ('ARS' → AR$, default US$ → $)."""
    return "AR$" if isinstance(conf, dict) and conf.get('currency') == 'ARS' else "$"

def format_df(df, user_config):
    if df.empty: return []
    if 'initial_quantity' not in df.columns and 'quantity' in df.columns: df['initial_quantity'] = df['quantity']
    
    # Asegurar que quantity sea numérico
    if 'quantity' in df.columns:
        df['quantity'] = pd.to_numeric(df['quantity'], errors='coerce').fillna(0)

    numeric_cols = df.select_dtypes(include=['float', 'float64']).columns
    for col in numeric_cols: df[col] = df[col].round(2)
    
    if isinstance(user_config, dict):
        for param in user_config.keys():
            if param not in RESERVED_CONFIG_KEYS:
                df[param] = df['tags'].apply(lambda x: (x or {}).get(param, "-"))
    return df.to_dict("records")

def add_pnl_pct(df):
    """Agrega columna pnl_pct: retorno % del trade sobre el capital invertido (entrada × cantidad)."""
    if df.empty or 'pnl' not in df.columns:
        return df
    cost = (pd.to_numeric(df['entry_price'], errors='coerce') * pd.to_numeric(df['quantity'], errors='coerce')).replace(0, pd.NA)
    df['pnl_pct'] = (pd.to_numeric(df['pnl'], errors='coerce') / cost * 100).fillna(0.0).astype(float).round(2)
    return df

def calculate_live_metrics(df_open):
    if df_open.empty: return df_open
    df_open['current_price'] = df_open['entry_price']
    df_open['unrealized_pnl'] = 0.0
    df_open['open_risk'] = 0.0
    df_open['unrealized_pnl_pct'] = 0.0
    df_open['open_risk_pct'] = 0.0

    try:
        tickers = [t for t in df_open['symbol'].unique() if t]
        if tickers:
            # USAR CACHE EN LUGAR DE DESCARGA DIRECTA
            data = get_cached_live_prices(tickers)
            
            if data is not None:  # Solo procesar si tenemos datos
                def get_p(row):
                    s = row['symbol']
                    try:
                        if isinstance(data, pd.Series): 
                            return float(data.iloc[-1])
                        if isinstance(data, pd.DataFrame) and s in data: 
                            return float(data[s].iloc[-1])
                        return row['entry_price']
                    except: 
                        return row['entry_price']
                
                df_open['current_price'] = df_open.apply(get_p, axis=1)
                df_open['unrealized_pnl'] = df_open.apply(
                    lambda x: (x['current_price']-x['entry_price'])*x['quantity'] 
                    if x['side']=='LONG' 
                    else (x['entry_price']-x['current_price'])*x['quantity'], 
                    axis=1
                )
                df_open['open_risk'] = df_open.apply(
                    lambda x: (x['current_stop_loss']-x['entry_price'])*x['quantity']
                    if x['side']=='LONG'
                    else (x['entry_price']-x['current_stop_loss'])*x['quantity'],
                    axis=1
                )
                # Versión porcentual sobre el costo de la posición (entrada × cantidad)
                cost = (df_open['entry_price'] * df_open['quantity']).replace(0, pd.NA)
                df_open['unrealized_pnl_pct'] = (df_open['unrealized_pnl'] / cost * 100).fillna(0.0)
                df_open['open_risk_pct'] = (df_open['open_risk'] / cost * 100).fillna(0.0)
                for c in ['current_price','unrealized_pnl','open_risk','unrealized_pnl_pct','open_risk_pct']:
                    df_open[c] = df_open[c].astype(float).round(2)
    except Exception as e:
        print(f"[ERROR] calculate_live_metrics: {e}")
        pass
    
    return df_open

def calc_fd_bins(data):
    if len(data) < 2: return 10
    q75, q25 = np.percentile(data, [75, 25])
    iqr = q75 - q25
    if iqr == 0: return 20
    h = 2 * iqr / (len(data) ** (1/3))
    if h <= 0: return 20
    bins = int((np.max(data) - np.min(data)) / h)
    return max(10, min(bins, 150))

def safe_float(val):
    if pd.isna(val) or val == "": return 0.0
    try:
        if isinstance(val, (int, float)): return float(val)
        s = str(val).strip()
        s = re.sub(r'[^\d.,-]', '', s) 
        if ',' in s and '.' in s:
            if s.find(',') > s.find('.'): s = s.replace('.', '').replace(',', '.')
            else: s = s.replace(',', '')
        elif ',' in s: s = s.replace(',', '.')
        return float(s)
    except: return 0.0
def build_daily_portfolio(df_closed, initial_balance, df_open=None, cash_movements_df=None):
    """
    Calcula el valor diario del portfolio basado en trades históricos.
    Descarga precios diarios vía yfinance para posiciones abiertas en cada día.

    Args:
        df_closed: DataFrame con trades cerrados (columnas: symbol, entry_date, exit_date,
                   entry_price, exit_price, quantity, side)
        initial_balance: Capital inicial del portfolio
        df_open: DataFrame con trades abiertos (opcional). Se incluyen desde entry_date hasta hoy.
        cash_movements_df: DataFrame opcional con aportes/retiros externos
                           (columnas: movement_date, amount, movement_type)

    Returns:
        DataFrame con: date, total_value, cash, equity_value, external_flow,
                       daily_return, cumulative_return (daily time-weighted return)
    """
    # Combinar trades cerrados y abiertos
    df_parts = []
    if not df_closed.empty:
        df_c = df_closed.copy()
        df_c['entry_date'] = pd.to_datetime(df_c['entry_date']).dt.normalize()
        df_c['exit_date'] = pd.to_datetime(df_c['exit_date']).dt.normalize()
        df_parts.append(df_c)
    if df_open is not None and not df_open.empty:
        df_o = df_open[['symbol', 'side', 'entry_date', 'entry_price', 'quantity']].copy()
        df_o['entry_date'] = pd.to_datetime(df_o['entry_date']).dt.normalize()
        df_o['exit_date'] = pd.NaT
        df_o['exit_price'] = np.nan
        df_parts.append(df_o)
    if not df_parts:
        return pd.DataFrame(columns=['date', 'total_value', 'cumulative_return', 'daily_return'])
    df = pd.concat(df_parts, ignore_index=True)

    # Rango de fechas
    start_date = df['entry_date'].min().date()
    end_date = df['exit_date'].max().date()
    if pd.isna(end_date) or end_date < date.today():
        end_date = date.today()

    # Preparar movimientos externos (aportes/retiros)
    movements = pd.DataFrame()
    if cash_movements_df is not None and not cash_movements_df.empty:
        movements = cash_movements_df.copy()
        movements['movement_date'] = pd.to_datetime(movements['movement_date']).dt.normalize()
        movements['signed_amount'] = movements.apply(
            lambda r: float(r['amount']) if r['movement_type'] == 'APORTE' else -float(r['amount']),
            axis=1
        )
        # Extender el rango si hay movimientos fuera del rango de trades
        start_date = min(start_date, movements['movement_date'].min().date())
        end_date = max(end_date, movements['movement_date'].max().date())

    # Descargar precios históricos de todos los tickers (con cache de 10 min)
    tickers = list(df['symbol'].unique())
    try:
        hist_key = (tuple(sorted(tickers)), str(start_date), str(end_date))
        now_hist = dt_datetime.now()
        if hist_key in _hist_price_cache and (now_hist - _hist_price_cache_time[hist_key]).total_seconds() < HIST_CACHE_TTL:
            prices_raw = _hist_price_cache[hist_key]
            print(f"[PERFORMANCE] ⚡ Precios históricos desde cache ({len(tickers)} tickers)")
        else:
            print(f"[PERFORMANCE] Descargando precios para {len(tickers)} tickers: {tickers}")
            print(f"[PERFORMANCE] Rango de fechas: {start_date} → {end_date}")

            prices_raw = yf.download(
                tickers=tickers,
                start=start_date,
                end=end_date + timedelta(days=1),
                auto_adjust=False,
                progress=False
            )
            _hist_price_cache[hist_key] = prices_raw
            _hist_price_cache_time[hist_key] = now_hist
            print(f"[PERFORMANCE] Descarga completada. Shape: {prices_raw.shape}")
        
        # Formatear precios: siempre producir columnas simples {ticker: precio_cierre}
        # yfinance puede retornar MultiIndex (Price, Ticker) o columnas simples según versión
        if isinstance(prices_raw.columns, pd.MultiIndex):
            prices = prices_raw["Close"]  # DataFrame con tickers como columnas simples
            if isinstance(prices, pd.Series):
                prices = prices.to_frame(name=tickers[0])
        elif len(tickers) == 1:
            prices = prices_raw[["Close"]].rename(columns={"Close": tickers[0]})
        else:
            prices = prices_raw["Close"]
        
        prices.index = pd.to_datetime(prices.index).normalize()
        print(f"[PERFORMANCE] Precios formateados correctamente. {len(prices)} días descargados.")
        # FIX: Rango continuo de business days para eliminar saltos
        full_bdays = pd.bdate_range(start=start_date, end=end_date)
        prices = prices.reindex(full_bdays).ffill().bfill()
    except Exception as e:
        print(f"[PERFORMANCE] ❌ ERROR descargando precios: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        raise Exception(f"No se pudieron descargar precios de Yahoo Finance. Verificá tu conexión a internet. Error: {str(e)}")
    
    # Calcular cash flows en cada fecha
    # --- LÓGICA DE CASH FLOW INSTITUCIONAL (LONG / SHORT) ---
    cash_flows = {}
    for _, trade in df.iterrows():
        entry = trade['entry_date']
        cost = trade['quantity'] * trade['entry_price']
        exit_d = trade['exit_date']
        revenue = trade['quantity'] * trade['exit_price'] if pd.notna(exit_d) else 0
        
        if trade['side'] == 'LONG':
            # LONG: Pago al entrar, cobro al salir
            cash_flows[entry] = cash_flows.get(entry, 0) - cost
            if pd.notna(exit_d):
                cash_flows[exit_d] = cash_flows.get(exit_d, 0) + revenue
        else:
            # SHORT: Cobro al vender corto, pago para recomprar
            cash_flows[entry] = cash_flows.get(entry, 0) + cost
            if pd.notna(exit_d):
                cash_flows[exit_d] = cash_flows.get(exit_d, 0) - revenue

    bday_index = prices.index

    def snap_to_bday(d):
        """Asigna una fecha al siguiente día hábil del índice (o al último si se pasa)."""
        pos = bday_index.searchsorted(d)
        if pos >= len(bday_index):
            pos = len(bday_index) - 1
        return bday_index[pos]

    # Los flujos de trades en días no hábiles (ej: fecha de entrada un sábado) se
    # reasignan al siguiente día hábil; si no, el loop diario los salta y el
    # portfolio muestra un salto fantasma.
    snapped_flows = {}
    for d, amt in cash_flows.items():
        key = snap_to_bday(d)
        snapped_flows[key] = snapped_flows.get(key, 0) + amt
    cash_flows = snapped_flows

    # Flujos externos (aportes/retiros) por día hábil.
    external_flows = {}
    if not movements.empty:
        for _, mov in movements.iterrows():
            day_key = snap_to_bday(mov['movement_date'])
            external_flows[day_key] = external_flows.get(day_key, 0) + mov['signed_amount']

    all_dates = prices.index

    # ── Valuación VECTORIZADA (una operación por trade, no por día) ──
    # Flujos de caja diarios (trades + externos)
    flow_series = pd.Series(0.0, index=all_dates)
    for d, amt in cash_flows.items():
        flow_series.loc[d] += amt
    ext_series = pd.Series(0.0, index=all_dates)
    for d, amt in external_flows.items():
        ext_series.loc[d] += amt

    cash_series = float(initial_balance) + (flow_series + ext_series).cumsum()

    # Equity: cada trade aporta qty × precio en su ventana [entry, exit)
    # (mismo criterio que antes: abierto si entry <= día y (sin exit o exit > día);
    #  fallback al precio de entrada si el ticker no tiene datos; SHORT resta como pasivo)
    equity_values = np.zeros(len(all_dates))
    for _, trade in df.iterrows():
        window = (all_dates >= trade['entry_date'])
        if pd.notna(trade['exit_date']):
            window &= (all_dates < trade['exit_date'])
        if not window.any():
            continue
        ticker = trade['symbol']
        if ticker in prices.columns:
            col = prices[ticker].fillna(trade['entry_price']).values
        else:
            col = np.full(len(all_dates), float(trade['entry_price']))
        sign = 1.0 if trade['side'] == 'LONG' else -1.0
        equity_values += np.where(window, sign * trade['quantity'] * col, 0.0)

    total_values = cash_series.values + equity_values
    result = pd.DataFrame({
        'date': all_dates,
        'total_value': total_values,
        'cash': cash_series.values,
        'equity_value': equity_values,
        'external_flow': ext_series.values
    })

    # Daily Time-Weighted Return (método Schwab): cada retorno diario descuenta
    # los aportes/retiros del día, así los flujos externos no afectan el % de retorno.
    #   r_t = (V_t - CF_t) / V_{t-1} - 1   →   TWR = Π(1 + r_t) - 1
    prev_value = result['total_value'].shift(1)
    prev_value.iloc[0] = float(initial_balance)
    denom = prev_value.where(prev_value > 0)
    result['daily_return'] = ((result['total_value'] - result['external_flow']) / denom - 1).fillna(0.0)
    result['cumulative_return'] = (1 + result['daily_return']).cumprod() - 1

    return result

def parse_contents(contents, filename, username):
    if not contents: return "Archivo vacío", []
    content_type, content_string = contents.split(',')
    decoded = base64.b64decode(content_string)
    detected_strategy_keys = set()
    
    try:
        if 'csv' in filename.lower():
            df = pd.read_csv(io.StringIO(decoded.decode('utf-8')))
        elif 'xls' in filename.lower():
            df = pd.read_excel(io.BytesIO(decoded))
        else:
            return "Formato no soportado. Usa CSV o Excel.", []
        
        df.columns = df.columns.str.strip().str.upper()
        
        count = 0
        for _, row in df.iterrows():
            symbol = str(row.get('TICKER', row.get('SYMBOL', ''))).upper()
            if not symbol or symbol == 'NAN': continue
            
            side = str(row.get('SIDE', 'LONG')).upper()
            qty = int(safe_float(row.get('QTY', row.get('QUANTITY', 0))))
            precio_in = safe_float(row.get('PRECIO IN', row.get('PRECIO ENTRADA', row.get('ENTRY_PRICE', row.get('PRICE', row.get('PRECIO', 0))))))
            
            p_out_raw = row.get('PRECIO OUT', row.get('PRECIO SALIDA', row.get('EXIT_PRICE', row.get('EXIT PRICE', None))))
            if pd.notna(p_out_raw): precio_out = safe_float(p_out_raw)
            else: precio_out = precio_in 

            sl = safe_float(row.get('SL', row.get('STOP LOSS', row.get('STOPLOSS', row.get('INITIAL_STOP_LOSS', row.get('S.L.', 0))))))
            
            try: 
                f_in = row.get('FECHA IN', row.get('ENTRY DATE', row.get('ENTRY_DATE', row.get('DATE', row.get('FECHA', date.today())))))
                fecha_in = pd.to_datetime(f_in).strftime('%Y-%m-%d')
            except: fecha_in = date.today().strftime('%Y-%m-%d')
            
            try: 
                f_out = row.get('FECHA OUT', row.get('EXIT DATE', row.get('EXIT_DATE', fecha_in)))
                fecha_out = pd.to_datetime(f_out).strftime('%Y-%m-%d')
            except: fecha_out = date.today().strftime('%Y-%m-%d')
            
            res_val = row.get('RESULTADO', row.get('RESULT', row.get('RESULT_TYPE', 'WIN')))
            resultado = str(res_val).upper() if pd.notna(res_val) else 'WIN'
            if resultado not in ['WIN', 'LOSS', 'BE']: resultado = 'WIN'
            
            known_cols = ['TICKER', 'SYMBOL', 'SIDE', 'QTY', 'QUANTITY', 
                          'PRECIO IN', 'PRECIO ENTRADA', 'ENTRY_PRICE', 'PRICE', 'PRECIO', 
                          'PRECIO OUT', 'PRECIO SALIDA', 'EXIT_PRICE', 'EXIT PRICE', 
                          'FECHA IN', 'ENTRY DATE', 'ENTRY_DATE', 'DATE', 'FECHA', 
                          'FECHA OUT', 'EXIT DATE', 'EXIT_DATE', 
                          'SL', 'STOP LOSS', 'STOPLOSS', 'INITIAL_STOP_LOSS', 'S.L.', 'CURRENT_STOP_LOSS',
                          'RESULTADO', 'RESULT', 'RESULT_TYPE', 'PNL', 'RR', 'PNL $', 'P&L', 'R', 'RISK', 'REWARD',
                          'ENTRY NOTES', 'EXIT NOTES', 'NOTAS ENTRADA', 'NOTAS SALIDA', 'NOTES']
            
            tags = {}
            for k, v in row.items():
                if k not in known_cols and pd.notna(v):
                    clean_key = str(k).title() 
                    tags[clean_key] = str(v)
                    detected_strategy_keys.add(clean_key)
            
            db.open_new_trade(username, symbol, side, precio_in, qty, fecha_in, sl, sl, tags)
            
            df_open = db.get_open_trades(username)
            if not df_open.empty:
                last_id = df_open['id'].max()
                db.close_trade_total(last_id, precio_out, fecha_out, resultado)
                count += 1
                
        return f"✅ {count} trades importados.", list(detected_strategy_keys)
    except Exception as e:
        print(f"Error parse_contents: {e}")
        return "❌ Error al leer el archivo.", []
def run_monte_carlo_simulation(df_closed, n_simulations, kelly_fraction, trades_per_sim=100):
    # Valores por defecto
    empty_fig = {"layout": {"xaxis": {"visible": False}, "yaxis": {"visible": False}, "plot_bgcolor": "rgba(0,0,0,0)", "paper_bgcolor": "rgba(0,0,0,0)"}}
    if df_closed.empty: return empty_fig, empty_fig, empty_fig, empty_fig, []
    
    def style_fig(fig):
        fig.update_layout(
            paper_bgcolor=CARD_BG, 
            plot_bgcolor=CARD_BG, 
            font_color=COLOR_NEUTRAL, 
            font_family="'Inter', 'Segoe UI', sans-serif", 
            margin=dict(l=20, r=20, t=40, b=20), 
            xaxis=dict(showgrid=True, gridcolor=BORDER_COLOR), 
            yaxis=dict(showgrid=True, gridcolor=BORDER_COLOR)
        )
        return fig

    # Aseguramos columna RR
    if 'rr' not in df_closed.columns: df_closed['rr'] = 0
    
    # Determinar resultado limpio
    res_col = next((c for c in df_closed.columns if c.lower() == 'result_type'), None)
    if res_col:
        df_closed['clean_res'] = df_closed[res_col].astype(str).str.strip().str.upper()
    else:
        df_closed['clean_res'] = np.where(df_closed['rr'] > 0, 'WIN', np.where(df_closed['rr'] < 0, 'LOSS', 'BE'))

    wins_df = df_closed[df_closed['clean_res'] == 'WIN']
    losses_df = df_closed[df_closed['clean_res'] == 'LOSS']

    n_wins = len(wins_df); n_losses = len(losses_df); active = n_wins + n_losses
    if active == 0: return empty_fig, empty_fig, empty_fig, empty_fig, []

    # --- ESTADISTICAS PARA KELLY ---
    p = n_wins / active # W (Win Rate)
    q = 1.0 - p         # L (Loss Rate)
    
    avg_win_r = wins_df['rr'].mean() if not wins_df.empty else 0
    avg_loss_r = abs(losses_df['rr'].mean()) if not losses_df.empty else 1.0
    
    # B = Payoff Ratio
    B = avg_win_r / avg_loss_r if avg_loss_r != 0 else 0
    
    # Kelly Teorico Completo
    if B > 0:
        kelly_full = max(0, (p * (B + 1) - 1) / B)
    else:
        kelly_full = 0
        
    f_used = kelly_full * kelly_fraction

    # --- GENERACION DE CURVA DE KELLY ---
    limit_search = min(0.99, max(0.4, kelly_full * 2.5))
    raw_f = np.linspace(0, limit_search, 300)
    
    plot_f = []
    plot_g = []

    for f in raw_f:
        term1 = (1 + f * B) ** p
        term2 = (1 - f) ** q
        g = (term1 * term2) - 1
        g_pct = g * 100
        
        # Filtro estricto: solo positivos
        if g_pct > 0: 
            plot_f.append(f)
            plot_g.append(g_pct)
        elif len(plot_f) > 0 and g_pct <= 0:
            plot_f.append(f)
            plot_g.append(0)
            break

    fig_kelly = go.Figure()
    fig_kelly.add_trace(go.Scatter(x=plot_f, y=plot_g, mode='lines', name='Curva G(f)', line=dict(color='#90A4AE', width=3)))
    
    multipliers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    
    for m in multipliers:
        f_point = kelly_full * m
        if f_point >= 1.0 or f_point <= 0: continue 
        
        t1 = (1 + f_point * B) ** p
        t2 = (1 - f_point) ** q
        g_point = ((t1 * t2) - 1) * 100
        
        if m == 1.0:
            color = 'red'; symbol = 'diamond'; size = 12; label = "<b>1.0x (Max)</b>"
        else:
            color = COLOR_SPY; symbol = 'circle'; size = 8; label = f"{m}x"

        if g_point > 0.01: 
            fig_kelly.add_trace(go.Scatter(
                x=[f_point], y=[g_point],
                mode='markers+text',
                name=f'{m}x Kelly',
                marker=dict(color=color, size=size, symbol=symbol, line=dict(color='black', width=1)),
                text=[label],
                textposition="top center",
                textfont=dict(size=10, color=TEXT_MAIN)
            ))

    fig_kelly.update_layout(
        title="CURVA DE CRECIMIENTO VS RIESGO",
        xaxis_title="Fraccion de Riesgo (f)",
        yaxis_title="Tasa de crecimiento geometrico esperado (%)",
        showlegend=False,
        margin=dict(l=20, r=20, t=40, b=20)
    )
    fig_kelly = style_fig(fig_kelly)

    # --- SIMULACION MONTE CARLO ---
    rr_pop = df_closed['rr'].dropna().tolist()
    if not rr_pop: return empty_fig, empty_fig, empty_fig, empty_fig, []
    
    sim_r = np.random.choice(rr_pop, size=(n_simulations, trades_per_sim))
    sim_curves = np.cumprod(1 + (sim_r * f_used), axis=1)
    sim_curves = np.insert(sim_curves, 0, 1.0, axis=1)

    # Métricas
    final_ret = (sim_curves[:, -1] - 1) * 100
    peaks = np.maximum.accumulate(sim_curves, axis=1)
    dd = (sim_curves - peaks) / peaks
    max_dd = np.min(dd, axis=1) * 100
    # Riesgo de Ruina: curvas que tocaron 0 o menos en algún momento
    ruin_count = np.sum(np.any(sim_curves <= 0, axis=1))
    ruin_pct = (ruin_count / n_simulations) * 100
    # Estadisticas
    mean_ret = np.mean(final_ret)
    med_ret = np.median(final_ret)
    std_ret = np.std(final_ret)
    
    mean_dd = np.mean(max_dd)
    med_dd = np.median(max_dd)
    p05_dd = np.percentile(max_dd, 5) 

    # Helper altura
    def get_max_y(data, bins):
        counts, _ = np.histogram(data, bins=bins)
        return max(counts) * 1.05

    border = dict(marker_line_color=CARD_BG, marker_line_width=1)

    # --- GRAFICO RETORNOS ---
    bins_ret = calc_fd_bins(final_ret)
    fig_ret = px.histogram(x=final_ret, nbins=bins_ret, title=f"DISTRIBUCION RETORNOS", template='plotly_dark')
    fig_ret.update_traces(marker_color=COLOR_POS, **border, showlegend=False)
    
    max_y_ret = get_max_y(final_ret, bins_ret)
    fig_ret.add_trace(go.Scatter(x=[mean_ret, mean_ret], y=[0, max_y_ret], mode='lines', name=f'Media: {mean_ret:.1f}%', line=dict(color=COLOR_NEG, dash='dash', width=2)))
    fig_ret.add_trace(go.Scatter(x=[med_ret, med_ret], y=[0, max_y_ret], mode='lines', name=f'Mediana: {med_ret:.1f}%', line=dict(color='orange', dash='dot', width=2)))
    fig_ret = style_fig(fig_ret)

    # --- GRAFICO DRAWDOWN ---
    bins_dd = calc_fd_bins(max_dd)
    fig_dd = px.histogram(x=max_dd, nbins=bins_dd, title="DISTRIBUCION MAX DD", template='plotly_dark')
    fig_dd.update_traces(marker_color=COLOR_NEG, **border, showlegend=False)
    
    max_y_dd = get_max_y(max_dd, bins_dd)
    fig_dd.add_trace(go.Scatter(x=[mean_dd, mean_dd], y=[0, max_y_dd], mode='lines', name=f'Media: {mean_dd:.1f}%', line=dict(color=COLOR_POS, dash='dash', width=2)))
    fig_dd.add_trace(go.Scatter(x=[med_dd, med_dd], y=[0, max_y_dd], mode='lines', name=f'Mediana: {med_dd:.1f}%', line=dict(color='yellow', dash='dot', width=2)))
    fig_dd.add_trace(go.Scatter(x=[p05_dd, p05_dd], y=[0, max_y_dd], mode='lines', name=f'Peor 5%: {p05_dd:.1f}%', line=dict(color='cyan', width=3))) 
    fig_dd = style_fig(fig_dd)

    # --- GRAFICO CURVAS ---
    fig_eq = go.Figure()
    # Cantidad mostrada vs total
    n_shown = min(50, n_simulations)
    
    for i in range(n_shown): 
        fig_eq.add_trace(go.Scatter(y=sim_curves[i], mode='lines', line=dict(width=1), opacity=0.15, showlegend=False, hoverinfo='skip'))
    
    fig_eq.add_trace(go.Scatter(y=np.median(sim_curves, axis=0), mode='lines', name='Mediana', line=dict(color=COLOR_NEUTRAL, width=3)))
    
    # Titulo actualizado con contador
    fig_eq.update_layout(title=f"PROYECCION (ESCALA LOG) - Mostrando {n_shown} de {n_simulations} curvas", template='plotly_dark', xaxis_title="Trades", yaxis_type="log")
    fig_eq = style_fig(fig_eq)

    def make_card(val, label, color=None):
        val_s = KPI_VAL_STYLE.copy(); 
        if color: val_s['color'] = color
        return dbc.Col(html.Div([html.P(val, style=val_s), html.P(label, style=KPI_LBL_STYLE)], style=KPI_CARD_STYLE), width="auto", className="mb-2 p-1")

    # --- KPI LIST ACTUALIZADA ---
    kpis = html.Div(dbc.Row([
        make_card(f"{p*100:.1f}%", "WIN RATE ", COLOR_NEUTRAL),
        make_card(f"{B:.2f}", "RATIO R/B", COLOR_NEUTRAL),
        make_card(f"{kelly_full*100:.2f}%", "KELLY OPTIMO", COLOR_POS), 
        make_card(f"{f_used*100:.2f}%", f"RIESGO (x{kelly_fraction})", COLOR_POS),
        make_card(f"{mean_ret:.1f}%", "MEDIA RETORNO", COLOR_POS),
        make_card(f"{med_ret:.1f}%", "MEDIANA RETORNO", COLOR_POS), 
        make_card(f"{std_ret:.1f}%", "DESVIO DE RETORNOS", COLOR_NEUTRAL),
        make_card(f"{p05_dd:.1f}%", "VAR 95%", "red"),
        make_card(f"{ruin_pct:.1f}%", "RIESGO DE RUINA", "red")
    ], className="flex-nowrap g-3", style={"padding": "10px 5px"}), style=SCROLL_CONTAINER_STYLE)

    return fig_ret, fig_dd, fig_eq, fig_kelly, kpis
# --- HELPER: ANALYTICS ---
def get_analytics_figures(df_closed, df_open, start_bal, user_config, selected_metric, cash_movements_df=None):
    empty = {"layout": {"xaxis": {"visible": False}, "yaxis": {"visible": False}, "plot_bgcolor": "rgba(0,0,0,0)", "paper_bgcolor": "rgba(0,0,0,0)",
                        "annotations": [{"text": "Sin datos — registrá tus primeros trades en OPERATIVA", "showarrow": False,
                                         "xref": "paper", "yref": "paper", "x": 0.5, "y": 0.5,
                                         "font": {"color": COLOR_NEUTRAL, "family": "Inter, Segoe UI, sans-serif", "size": 13}}]}}
    
    def style_fig(fig):
        fig.update_layout(
            paper_bgcolor=CARD_BG, 
            plot_bgcolor=CARD_BG, 
            font_color=COLOR_NEUTRAL,
            font_family="'Inter', 'Segoe UI', sans-serif",
            margin=dict(l=20, r=20, t=40, b=20),
            xaxis=dict(showgrid=True, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR),
            yaxis=dict(showgrid=True, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR)
        )
        return fig

    if not df_closed.empty:
        df_closed = df_closed.sort_values('exit_date', ascending=True).reset_index(drop=True)
        df_closed['trade_num'] = range(1, len(df_closed)+1)
        
        res_col = next((c for c in df_closed.columns if c.lower() == 'result_type'), None)
        if res_col:
            df_closed['pnl_cat_fixed'] = df_closed[res_col].astype(str).str.strip().str.upper()
        else:
            df_closed['pnl_cat_fixed'] = np.where(df_closed['pnl'] > 0, 'WIN', np.where(df_closed['pnl'] < 0, 'LOSS', 'BE'))

        if isinstance(user_config, dict):
            for k in user_config:
                if k not in RESERVED_CONFIG_KEYS:
                    df_closed[k] = df_closed['tags'].apply(lambda x: (x or {}).get(k, "-"))
        
        df_closed['cum'] = df_closed['pnl'].cumsum()
        # La curva de equity refleja solo el resultado de la operatoria:
        # capital inicial + PnL acumulado, sin aportes/retiros externos.
        df_closed['eq'] = start_bal + df_closed['cum']
        df_closed['peak'] = df_closed['eq'].cummax()
        df_closed['dd'] = ((df_closed['eq'] - df_closed['peak']) / df_closed['peak']) * 100
        total_pnl = df_closed['pnl'].sum()
        
        is_win = (df_closed['pnl_cat_fixed'] == 'WIN').astype(int)
        is_loss = (df_closed['pnl_cat_fixed'] == 'LOSS').astype(int)
        is_be = (df_closed['pnl_cat_fixed'] == 'BE').astype(int)
        
        wins = df_closed[is_win == 1]
        losses = df_closed[is_loss == 1]
        be = df_closed[is_be == 1]

        n_wins = len(wins)
        n_losses = len(losses)
        n_be = len(be)
        
        active_trades = n_wins + n_losses 
        
        win_rate = (n_wins / active_trades * 100) if active_trades > 0 else 0
        loss_rate = (n_losses / active_trades * 100) if active_trades > 0 else 0
        
        avg_win = wins['pnl'].mean() if not wins.empty else 0
        avg_loss = abs(losses['pnl'].mean()) if not losses.empty else 0
        avg_win_r = wins['rr'].mean() if not wins.empty else 0
        avg_loss_r = abs(losses['rr'].mean()) if not losses.empty else 0
        
        ratio_money = avg_win / avg_loss if avg_loss != 0 else 0
        ratio_r = avg_win_r / avg_loss_r if avg_loss_r != 0 else 0
        
        exp_abs = ((win_rate/100) * ratio_money) - (loss_rate/100)
        exp_money = ((win_rate/100) * avg_win) - ((loss_rate/100) * avg_loss)
        exp_r = ((win_rate/100) * avg_win_r) - ((loss_rate/100) * avg_loss_r)
        
        max_dd = df_closed['dd'].min()
        current_dd = df_closed['dd'].iloc[-1]

        cum_wins = is_win.cumsum()
        cum_losses = is_loss.cumsum()
        cum_be = is_be.cumsum()
        cum_active = cum_wins + cum_losses
        cum_total = df_closed['trade_num']
        
        df_closed['cum_win_rate'] = np.where(cum_active > 0, (cum_wins / cum_active) * 100, 0)
        df_closed['cum_loss_rate'] = np.where(cum_active > 0, (cum_losses / cum_active) * 100, 0)
        df_closed['cum_be_rate'] = np.where(cum_total > 0, (cum_be / cum_total) * 100, 0)

        df_closed['win_r_val'] = np.where(is_win == 1, df_closed['rr'], 0)
        df_closed['loss_r_val'] = np.where(is_loss == 1, abs(df_closed['rr']), 0)
        cum_win_r = df_closed['win_r_val'].cumsum()
        cum_loss_r = df_closed['loss_r_val'].cumsum()
        
        avg_win_r_cum = np.where(cum_wins > 0, cum_win_r / cum_wins, 0)
        avg_loss_r_cum = np.where(cum_losses > 0, cum_loss_r / cum_losses, 1.0)
        df_closed['cum_ratio'] = np.where(avg_loss_r_cum > 0, avg_win_r_cum / avg_loss_r_cum, 0)

        # --- EQUITY CURVE ---
        fig_eq = px.line(df_closed, x='trade_num', y='eq', title='CURVA DE EQUITY', template='plotly_dark')
        fig_eq.update_traces(line_color=COLOR_POS, line_width=3, fill='tozeroy', fillcolor='rgba(0, 176, 189, 0.2)')
        fig_eq = style_fig(fig_eq)
        
        min_eq = df_closed['eq'].min()
        max_eq = df_closed['eq'].max()
        pad = (max_eq - min_eq) * 0.1 if max_eq != min_eq else start_bal * 0.05
        
        fig_eq.update_layout(
            margin=dict(t=40, b=0, l=20, r=20),
            yaxis_range=[min_eq - pad, max_eq + pad]
        )
        
        # --- DRAWDOWN ---
        fig_dd = px.area(df_closed, x='trade_num', y='dd', title='DRAWDOWN (%)', template='plotly_dark')
        fig_dd.update_traces(line_color=COLOR_NEG, fillcolor=f'rgba(246, 70, 93, 0.2)')
        fig_dd = style_fig(fig_dd)
        fig_dd.update_layout(height=200, margin=dict(t=10, b=20, l=20, r=20))
        
        # --- NUEVOS GRAFICOS ---
        fig_evo_winrate = go.Figure()
        fig_evo_winrate.add_trace(go.Scatter(x=df_closed['trade_num'], y=df_closed['cum_win_rate'], mode='lines', name='Win Rate', line=dict(color=COLOR_POS, width=2)))
        fig_evo_winrate.add_trace(go.Scatter(x=df_closed['trade_num'], y=df_closed['cum_loss_rate'], mode='lines', name='Loss Rate', line=dict(color=COLOR_NEG, width=2)))
        fig_evo_winrate.add_trace(go.Scatter(x=df_closed['trade_num'], y=df_closed['cum_be_rate'], mode='lines', name='BE Rate', line=dict(color=COLOR_NEUTRAL, width=2)))
        fig_evo_winrate.update_layout(title='EVOLUCION TASAS (%)', xaxis_title='Trades', yaxis_title='%', hovermode='x unified', legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        fig_evo_winrate = style_fig(fig_evo_winrate)

        fig_evo_ratio = go.Figure()
        fig_evo_ratio.add_trace(go.Scatter(x=df_closed['trade_num'], y=df_closed['cum_ratio'], mode='lines', name='Ratio R/B', line=dict(color=COLOR_SPY, width=2), fill='tozeroy', fillcolor='rgba(252, 213, 53, 0.1)'))
        fig_evo_ratio.update_layout(title='EVOLUCION RATIO R/B', xaxis_title='Trades', yaxis_title='Ratio', hovermode='x unified', showlegend=False)
        fig_evo_ratio = style_fig(fig_evo_ratio)

# --- EVOLUCION DEL EDGE (ESPERANZA MATEMATICA) ---
        # E(x) = (WinRate * R/B) - LossRate (convertido a fracciones para que el resultado sea en 'R')
        df_closed['cum_edge'] = (df_closed['cum_win_rate'] / 100) * df_closed['cum_ratio'] - (df_closed['cum_loss_rate'] / 100)
        
        fig_edge = go.Figure()
        
        # Trazamos la línea principal con relleno
        fig_edge.add_trace(go.Scatter(
            x=df_closed['trade_num'], 
            y=df_closed['cum_edge'], 
            mode='lines', 
            name='Esperanza', 
            line=dict(color=COLOR_POS, width=2.5), 
            fill='tozeroy', 
            fillcolor='rgba(0, 176, 189, 0.15)',
            hovertemplate='Trade %{x}<br>Edge Esperado: %{y:.2f}R<extra></extra>'
        ))
        
        # Línea de Break Even en 0 (Línea crítica de supervivencia)
        fig_edge.add_hline(
            y=0, 
            line_dash="dash", 
            line_color=COLOR_NEG, 
            line_width=1.5, 
            opacity=0.8
        )
        
        fig_edge.update_layout(
            title='EVOLUCION DEL EDGE (ESPERANZA EN R)', 
            xaxis_title='Trades', 
            yaxis_title='Esperanza (R)', 
            hovermode='x unified', 
            showlegend=False
        )
        fig_edge = style_fig(fig_edge)

        # --- HISTOGRAMA PNL ---
        def apply_square_root_rule(df_subset, cat_name):
            n = len(df_subset)
            if n == 0: return pd.DataFrame()
            if n == 1:
                val = df_subset['pnl'].iloc[0]
                return pd.DataFrame({'visual_bin': [val], 'range_label': [f"[{val:.2f}, {val:.2f}]"], 'pnl_cat_fixed': [cat_name], 'count': [1]})
            
            k = int(np.ceil(np.sqrt(n)))
            min_val = df_subset['pnl'].min()
            max_val = df_subset['pnl'].max()
            
            if max_val == min_val:
                return pd.DataFrame({'visual_bin': [min_val], 'range_label': [f"[{min_val:.2f}, {max_val:.2f}]"], 'pnl_cat_fixed': [cat_name], 'count': [n]})
                
            h = (max_val - min_val) / k
            bins = [min_val + i * h for i in range(k + 1)]
            bins[0] = min_val - 1e-9
            bins[-1] = max_val + 1e-9 
            
            cuts = pd.cut(df_subset['pnl'], bins=bins, include_lowest=True)
            df_subset['visual_bin'] = cuts.apply(lambda x: x.mid).astype(float)
            df_subset['range_label'] = cuts.apply(lambda x: f"[{max(min_val, x.left):.2f}, {min(max_val, x.right):.2f}]")
            
            agg = df_subset.groupby(['visual_bin', 'range_label']).size().reset_index(name='count')
            agg['pnl_cat_fixed'] = cat_name
            return agg[agg['count'] > 0]

        wins_df = df_closed[df_closed['pnl_cat_fixed'] == 'WIN'].copy()
        losses_df = df_closed[df_closed['pnl_cat_fixed'] == 'LOSS'].copy()
        be_df = df_closed[df_closed['pnl_cat_fixed'] == 'BE'].copy()

        hist_frames = []
        if not losses_df.empty: hist_frames.append(apply_square_root_rule(losses_df, 'LOSS'))
        if not be_df.empty:
            hist_frames.append(pd.DataFrame({'visual_bin': [0.0], 'range_label': ['[0.00, 0.00]'], 'pnl_cat_fixed': ['BE'], 'count': [len(be_df)]}))
        if not wins_df.empty: hist_frames.append(apply_square_root_rule(wins_df, 'WIN'))

        if hist_frames:
            hist_data = pd.concat(hist_frames, ignore_index=True)
            fig_h = px.bar(hist_data, x="range_label", y="count", color="pnl_cat_fixed", text="count",
                           barmode='group',
                           color_discrete_map={'WIN': COLOR_POS, 'LOSS': COLOR_NEG, 'BE': COLOR_NEUTRAL},
                           hover_data={"range_label": True, "count": True},
                           title='DISTRIBUCION PNL', template='plotly_dark')
            fig_h.update_traces(marker_line_color=CARD_BG, marker_line_width=1.5, textposition='outside', textfont_color=TEXT_MAIN) 
            fig_h = style_fig(fig_h)
            fig_h.update_layout(bargap=0.05, bargroupgap=0.02, xaxis_title="Rango de PnL ($)", yaxis_title="Cantidad de Trades")
        else:
            fig_h = empty

        if selected_metric and selected_metric in df_closed:
            g = df_closed.groupby(selected_metric)
            pnl = g['pnl'].sum().reset_index(); cnt = g.size().reset_index(name='count')

            # Estilo sombreado (mismo look que el gráfico de exposición de Operativa)
            a_sym = cur_sym(user_config)
            a_fmt = lambda v: f"-{a_sym}{abs(v):,.0f}" if v < 0 else f"{a_sym}{v:,.0f}"
            a_label_font = dict(color=TEXT_MAIN, size=11, family="'Inter', 'Segoe UI', sans-serif")

            fig_s = px.bar(pnl, x=selected_metric, y='pnl', title=f'PNL POR {str(selected_metric).upper()}', template='plotly_dark')
            fig_s.update_traces(
                marker=dict(
                    color=np.where(pnl['pnl'] >= 0, "rgba(0, 176, 189, 0.4)", "rgba(246, 70, 93, 0.4)"),
                    line=dict(color=np.where(pnl['pnl'] >= 0, COLOR_POS, COLOR_NEG), width=1.5),
                    cornerradius=6
                ),
                text=pnl['pnl'].apply(a_fmt),
                textposition='outside', textfont=a_label_font, cliponaxis=False,
                hovertemplate='%{x}<br>' + a_sym + '%{y:,.2f}<extra></extra>'
            )
            fig_s = style_fig(fig_s)
            fig_s.update_layout(bargap=0.35, yaxis=dict(showgrid=True, gridcolor="rgba(43, 49, 57, 0.5)", zerolinecolor=BORDER_COLOR, tickprefix=a_sym, tickformat=",.0f", title=None))

            fig_c = px.bar(cnt, x=selected_metric, y='count', title=f'TRADES POR {str(selected_metric).upper()}', template='plotly_dark')
            fig_c.update_traces(
                marker=dict(
                    color="rgba(132, 142, 156, 0.35)",
                    line=dict(color=COLOR_NEUTRAL, width=1.5),
                    cornerradius=6
                ),
                text=cnt['count'],
                textposition='outside', textfont=a_label_font, cliponaxis=False,
                hovertemplate='%{x}<br>%{y} trades<extra></extra>'
            )
            fig_c = style_fig(fig_c)
            fig_c.update_layout(bargap=0.35, yaxis=dict(showgrid=True, gridcolor="rgba(43, 49, 57, 0.5)", zerolinecolor=BORDER_COLOR, title=None))
        else: fig_s = fig_c = empty
        
        def make_card(val, label, color=None):
            val_s = KPI_VAL_STYLE.copy(); 
            if color: val_s['color'] = color
            return dbc.Col(html.Div([html.P(val, style=val_s), html.P(label, style=KPI_LBL_STYLE)], style=KPI_CARD_STYLE), width="auto", className="mb-2 p-1")
        
        kpis = html.Div(dbc.Row([
            make_card(f"{cur_sym(user_config)}{total_pnl:,.0f}", "PNL", COLOR_POS if total_pnl>=0 else COLOR_NEG),
            make_card(f"{len(df_closed)}", "TRADES"), 
            make_card(f"{n_wins}", "WINS", COLOR_POS), 
            make_card(f"{n_losses}", "LOSSES", COLOR_NEG), 
            make_card(f"{n_be}", "BE", COLOR_NEUTRAL),
            make_card(f"{win_rate:.1f}%", "WIN RATE"), 
            make_card(f"{loss_rate:.1f}%", "LOSS RATE"),
            # --- NOMBRES ACTUALIZADOS AQUI ---
            make_card(f"{ratio_money:.2f}", "RISK REWARD ($) AVG HISTORICO"), 
            make_card(f"{ratio_r:.2f}", "RISK REWARD (RR) AVG HISTORICO"),
            make_card(f"{exp_abs:.2f}", "E(x)"),
            make_card(f"{cur_sym(user_config)}{exp_money:.2f}", f"E(x)({cur_sym(user_config)})"),
            make_card(f"{exp_r:.2f}R", "E(x)(RR)"),
            # ---------------------------------
            make_card(f"{max_dd:.2f}%", "MAX DD", COLOR_NEG),
            make_card(f"{current_dd:.2f}%", "DD ACT", COLOR_NEG if current_dd < 0 else COLOR_POS)
        ], className="flex-nowrap g-3", style={"padding": "10px 5px"}), style=SCROLL_CONTAINER_STYLE)
    else: fig_eq=fig_dd=fig_edge=fig_h=fig_s=fig_c=fig_evo_winrate=fig_evo_ratio=empty; kpis=[]

    if not df_open.empty:
        df_open = calculate_live_metrics(df_open)
        unrl = df_open['unrealized_pnl'].sum(); risk = df_open['open_risk'].sum()
        df_open['val'] = df_open['entry_price'] * df_open['quantity']
        pf_d = df_open.groupby('symbol')['val'].sum().reset_index(name='v')
        # La liquidez sí considera los aportes/retiros externos (valor real de cuenta),
        # aunque la curva de equity no los incluya.
        net_flows = 0.0
        if cash_movements_df is not None and not cash_movements_df.empty:
            net_flows = cash_movements_df.apply(
                lambda r: float(r['amount']) if r['movement_type'] == 'APORTE' else -float(r['amount']),
                axis=1
            ).sum()
        account_value = (df_closed['eq'].iloc[-1] if not df_closed.empty else start_bal) + net_flows
        liq = account_value - df_open['val'].sum()
        if liq < 0: liq = 0
        fig_pie = px.pie(names=pf_d['symbol'].tolist()+['Liquidez'], values=pf_d['v'].tolist()+[liq], title='EXPOSICION', template='plotly_dark', hole=0.6, color_discrete_sequence=[COLOR_NEUTRAL, COLOR_POS, COLOR_NEG, COLOR_SPY])
        fig_pie = style_fig(fig_pie)
    else: fig_pie=empty

    return fig_eq, fig_dd, fig_pie, fig_edge, fig_h, kpis, fig_s, fig_c, fig_evo_winrate, fig_evo_ratio
# --- PANEL DE GESTION DINAMICO (MOVIDO ARRIBA PARA QUE LO LEA EL LAYOUT) ---
def get_management_panel():
    return html.Div(id="management-container", style={'display': 'none'}, children=[
        dbc.Card([
            dbc.CardHeader("PANEL DE GESTION DE RIESGO", style={"backgroundColor": "transparent", "borderBottom": f"1px solid {BORDER_COLOR}", "fontWeight": "bold", "color": TEXT_MAIN, "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), 
            dbc.CardBody([
                html.Div(id="dyn-info", className="mb-3 fw-bold", style={"color": TEXT_MAIN, "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), 
                dbc.Tabs([
                    dbc.Tab(label="CERRAR POSICION", children=[
                        dbc.Row([
                            dbc.Col(dbc.Input(id="cp", placeholder="Precio Salida", type="number", style=INPUT_STYLE), width=4), 
                            dbc.Col(dbc.Input(id="cd", type="date", value=date.today(), style=INPUT_STYLE), width=4), 
                            dbc.Col(dbc.Select(id="cr", options=[{"label":x,"value":x} for x in ["WIN","LOSS","BE"]], value="WIN", style=INPUT_STYLE), width=4)
                        ], className="my-3"), 
                        dbc.Textarea(id="c-notes", placeholder="Notas de salida / Lecciones aprendidas...", style={"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "15px", "height": "80px"}),
                        dbc.Button("LIQUIDAR TOTALIDAD", id="btn-close", color="danger", className="w-100 fw-bold", style={"backgroundColor": COLOR_NEG, "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif"})
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE), 
                    
                    dbc.Tab(label="TOMA PARCIAL", children=[
                        dbc.Row([
                            dbc.Col(dbc.Input(id="pq", placeholder="Cantidad", type="number", style=INPUT_STYLE), width=4),
                            dbc.Col(dbc.Input(id="pp", placeholder="Precio Salida", type="number", style=INPUT_STYLE), width=4),
                            dbc.Col(dbc.Input(id="pd", type="date", value=date.today(), style=INPUT_STYLE), width=4)
                        ], className="my-3"),
                        dbc.Button("EJECUTAR PARCIAL", id="btn-part", color="light", className="w-100 fw-bold text-dark", style={"border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif"})
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE), 
                    
                    dbc.Tab(label="AJUSTAR SL", children=[
                        dbc.InputGroup([
                            dbc.InputGroupText("NUEVO SL", style={"backgroundColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                            dbc.Input(id="usl", type="number", style=INPUT_STYLE),
                            dbc.Button("ACTUALIZAR", id="btn-sl", color="light", className="text-dark", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"})
                        ], className="my-3")
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE),
                    dbc.Tab(label="BORRAR TODO", children=[
                        html.Div([
                            dcc.ConfirmDialogProvider(
                                children=dbc.Button("ELIMINAR TODAS LAS POSICIONES (RESET)", id="btn-del-all-open", color="danger", className="w-100 fw-bold", style={"backgroundColor": "rgba(246, 70, 93, 0.2)", "color": COLOR_NEG, "border": f"1px solid {COLOR_NEG}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                                id="confirm-del-all-open",
                                message="¿ESTÁS SEGURO? Se eliminarán TODOS los trades activos sin guardarlos en el historial."
                            )
                        ], className="my-3")
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE),
                    dbc.Tab(label="BORRAR OPERACIÓN", children=[
                        html.Div([
                            dbc.Button("ELIMINAR REGISTRO INDIVIDUAL (DB)", id="btn-del", color="dark", size="sm", className="w-100 mt-2 text-danger border-danger", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"})
                        ], className="my-3")
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE)
                ])
            ])
        ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 10px 30px rgba(0,0,0,0.5)"})
    ], className="mt-4")

# --- SHELL Y MODALES ---
global_modals = html.Div([
    dbc.Modal([dbc.ModalHeader("REGISTRO DE USUARIO", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), dbc.ModalBody([
        dbc.Input(id="reg-u", placeholder="Usuario", className="mb-3", style=INPUT_STYLE),
        dbc.Input(id="reg-p", placeholder="Contraseña", type="password", className="mb-3", style=INPUT_STYLE),
        dbc.Input(id="reg-n", placeholder="Nombre Completo", className="mb-3", style=INPUT_STYLE),
        dbc.Input(id="reg-e", placeholder="Email (para recuperar tu contraseña)", type="email", className="mb-3", style=INPUT_STYLE),
        html.Div([
            dbc.Checkbox(id="tc-accept", value=False, style={"display": "inline-block", "marginRight": "8px"}),
            html.Span("Leí y acepto los ", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem"}),
            html.A("Términos y Condiciones", id="open-tc", href="#", style={"color": COLOR_POS, "fontSize": "0.85rem", "textDecoration": "underline", "cursor": "pointer"})
        ], style={"display": "flex", "alignItems": "center", "flexWrap": "wrap", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
        html.Div(id="reg-msg", className="text-danger mt-2")
    ], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-reg", color="dark", className="ms-auto", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}), dbc.Button("ACEPTAR", id="do-reg", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-reg", is_open=False),
    dbc.Modal([
        dbc.ModalHeader("TÉRMINOS Y CONDICIONES", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
        dbc.ModalBody([
            html.P("Última actualización: julio 2026", style={"color": COLOR_NEUTRAL, "fontSize": "0.75rem"}),
            html.H6("1. Aceptación", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Al crear una cuenta en Edge Journal aceptás estos términos. Si no estás de acuerdo, no utilices la plataforma.", className="small"),
            html.H6("2. Naturaleza del servicio", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Edge Journal es una herramienta de registro y análisis de operaciones bursátiles con fines informativos y educativos. NO constituye asesoramiento financiero, recomendación de inversión ni oferta de compra o venta de ningún instrumento. Toda decisión de inversión es exclusiva responsabilidad del usuario.", className="small"),
            html.H6("3. Datos que registrás", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Para funcionar, la plataforma almacena la información que vos cargás: usuario, nombre, capital de referencia, operaciones (activos, precios, cantidades, fechas, notas), aportes y retiros, y parámetros de estrategia. Esta información se guarda en una base de datos gestionada (Supabase) y se usa únicamente para brindarte las funcionalidades de la plataforma.", className="small"),
            html.H6("4. Privacidad", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Tus datos no se venden, alquilan ni comparten con terceros. Solo son accesibles desde tu cuenta. Podés solicitar la eliminación completa de tu cuenta y sus datos en cualquier momento.", className="small"),
            html.H6("5. Datos de mercado", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Los precios y cotizaciones provienen de fuentes de terceros (Yahoo Finance) y pueden contener demoras, errores u omisiones. No se garantiza su exactitud ni disponibilidad. Los cálculos de rendimiento derivados son estimaciones y pueden diferir de los valores oficiales de tu broker.", className="small"),
            html.H6("6. Limitación de responsabilidad", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("La plataforma se ofrece \"tal cual\", sin garantías de ningún tipo. No nos responsabilizamos por pérdidas o daños derivados del uso de la plataforma, de decisiones de inversión tomadas en base a su información, ni por interrupciones del servicio o pérdida de datos.", className="small"),
            html.H6("7. Seguridad de la cuenta", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Sos responsable de mantener la confidencialidad de tus credenciales. Evitá reutilizar contraseñas de otros servicios.", className="small"),
            html.H6("8. Modificaciones", style={"color": TEXT_MAIN, "marginTop": "12px"}),
            html.P("Estos términos pueden actualizarse. El uso continuado de la plataforma tras una modificación implica su aceptación.", className="small"),
        ], style={"backgroundColor": CARD_BG, "color": COLOR_NEUTRAL, "maxHeight": "60vh", "overflowY": "auto", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
        dbc.ModalFooter(dbc.Button("CERRAR", id="close-tc", color="dark", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}), style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})
    ], id="modal-tc", is_open=False, size="lg", scrollable=True),
    dbc.Modal([
        dbc.ModalHeader("RECUPERAR CONTRASEÑA", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
        dbc.ModalBody([
            html.P("Ingresá tu usuario y el email con el que te registraste. Si coinciden, vas a poder definir una contraseña nueva.", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
            dbc.Input(id="rec-u", placeholder="Usuario", className="mb-3", style=INPUT_STYLE),
            dbc.Input(id="rec-e", placeholder="Email registrado", type="email", className="mb-3", style=INPUT_STYLE),
            dbc.Input(id="rec-p1", placeholder="Nueva contraseña", type="password", className="mb-3", style=INPUT_STYLE),
            dbc.Input(id="rec-p2", placeholder="Repetir nueva contraseña", type="password", style=INPUT_STYLE),
            html.Div(id="rec-msg", className="mt-2", style={"fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "minHeight": "20px"})
        ], style={"backgroundColor": CARD_BG}),
        dbc.ModalFooter([
            dbc.Button("CANCELAR", id="close-recovery", color="dark", className="ms-auto", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
            dbc.Button("RESTABLECER", id="do-recovery", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": "#000"})
        ], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})
    ], id="modal-recovery", is_open=False),
    dbc.Modal([dbc.ModalHeader("CONFIGURACION DE ESTRATEGIA", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), dbc.ModalBody([html.P("Definí parámetros para clasificar cada operación según el motivo por el cual fue tomada (ej: Trend Following, Buy & Hold, Swing Trading). Esto permite distinguir los trades entre las distintas variantes de operatoria y analizar el desempeño de cada una por separado en la pestaña de Analytics. (Ej: Parámetro: Trend Following — Opciones: MA Crossover, ATH, BreakOut)", style={"color": COLOR_NEUTRAL, "fontSize": "0.82rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "15px"}), dag.AgGrid(id="conf-grid", columnDefs=[{"field": "Parametro", "editable": True}, {"field": "Opciones", "editable": True, "flex": 1}], rowData=[], dashGridOptions={"rowSelection": "single", "stopEditingWhenCellsLoseFocus": True}, className="ag-theme-alpine-dark", style={"height": "300px", "borderRadius": "4px", **CUSTOM_GRID_STYLE}), dbc.Button("AGREGAR PARAMETRO", id="add-row-btn", color="dark", outline=True, size="sm", className="mt-3 w-100", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}), html.Hr(style={"borderColor": BORDER_COLOR}), dbc.Row([dbc.Col(dbc.Label("MONEDA DE LA CUENTA", className="fw-bold", style={"color": COLOR_NEUTRAL, "fontSize": "0.8rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "paddingTop": "8px"}), width=6), dbc.Col(dbc.Select(id="conf-currency", options=[{"label": "Dólar (US$)", "value": "USD"}, {"label": "Peso Argentino (AR$)", "value": "ARS"}], value="USD", style=INPUT_STYLE), width=6)]), html.P("Define el símbolo de los valores en toda la app. Para cuentas en pesos usá tickers de BYMA/CEDEARs con sufijo .BA (ej: GGAL.BA, AAPL.BA).", style={"color": COLOR_NEUTRAL, "fontSize": "0.75rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginTop": "8px", "marginBottom": "0"}), html.Div(id="config-feedback", className="mt-2 text-warning small")], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-config", color="dark", className="ms-auto", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}), dbc.Button("GUARDAR", id="save-config", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-config", is_open=False, size="lg")
])

def layout_login():
    return html.Div(
        dbc.Card([
            dbc.CardBody([
                html.H2("EDGE JOURNAL", className="text-center mb-1 fw-bold", style={"color": TEXT_MAIN, "letterSpacing": "3px", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "textShadow": f"0 0 24px {COLOR_POS}44"}),
                html.P("Trading journal & analytics", className="text-center", style={"color": COLOR_NEUTRAL, "fontSize": "0.8rem", "letterSpacing": "1px", "marginBottom": "28px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                dbc.Input(id="user-in", placeholder="Usuario", className="mb-3 p-3", style=INPUT_STYLE),
                dbc.Input(id="pass-in", placeholder="Password", type="password", className="mb-3 p-3", style=INPUT_STYLE),
                html.Div(id="login-msg", style={"color": COLOR_NEG, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "minHeight": "24px", "marginBottom": "10px", "textAlign": "center"}),
                dbc.Button("INICIAR SESION", id="login-btn", color="success", className="w-100 mb-3 p-3 fw-bold", style={"backgroundColor": COLOR_POS, "color": "#000", "border": "none", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                dbc.Button("Crear Cuenta", id="open-reg", color="link", className="w-100 text-decoration-none", style={"color": COLOR_NEUTRAL, "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                dbc.Button("¿Olvidaste tu contraseña?", id="open-recovery", color="link", size="sm", className="w-100 text-decoration-none", style={"color": COLOR_NEUTRAL, "fontSize": "0.78rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif"})
            ])
        ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "6px", "boxShadow": "0 24px 60px rgba(0,0,0,0.6)", "width": "100%", "maxWidth": "420px"}),
        style={"minHeight": "85vh", "display": "flex", "alignItems": "center", "justifyContent": "center"}
    )

def layout_dashboard(username):
    return html.Div([
        dbc.Row([
            dbc.Col(html.Div(f"USER: {username}", style={"color": COLOR_NEUTRAL, "fontSize": "14px", "fontWeight": "bold", "marginTop": "10px"}), width="auto"),
            dbc.Col(html.Div([html.Span("Posiciones abiertas:", style={"color": COLOR_NEUTRAL, "fontSize": "14px", "fontWeight": "bold", "marginRight": "8px", "whiteSpace": "nowrap"}), html.Span(id="header-pills", style={"display": "inline-flex", "flexWrap": "wrap", "gap": "5px", "alignItems": "center"})], style={"display": "flex", "alignItems": "center", "marginTop": "10px"})),
            dbc.Col(html.Div(id="g-msg", className="text-end fw-bold", style={"color": COLOR_NEUTRAL}), width="auto")
        ], className="mb-4 mt-1", align="center"),
        
        dcc.Tabs(id="tabs", value='tab-active', children=[
            dcc.Tab(label='OPERATIVA', value='tab-active', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='HISTORIAL', value='tab-history', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='ANALYTICS', value='tab-analytics', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='SIMULADOR DE RIESGO', value='tab-montecarlo', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='PERFORMANCE', value='tab-performance', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='INFORMACIÓN Y USO', value='tab-info', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE)
        ]), 
        # Paneles persistentes por pestaña (patrón SPA): cada pestaña se renderiza
        # una sola vez en su primera visita y después el cambio es un toggle de
        # visibilidad ejecutado en el navegador — instantáneo, sin ir al servidor.
        dcc.Store(id='rendered-tabs-store', data=[]),
        dcc.Loading(
            id="loading-tab",
            type="default",
            color=COLOR_NEUTRAL,
            # Solo el render inicial de cada panel dispara este spinner
            target_components={f"pane-{t}": "children" for t in TAB_IDS},
            children=html.Div([
                html.Div(id=f"pane-{t}", className="pt-4", style={'display': 'none'})
                for t in TAB_IDS
            ])
        ), html.Div(id="hidden-wrapper")
    ])

# --- WRAPPER GENERAL PREMIUM ---
app.layout = html.Div([
    dcc.Store(id='session-store', storage_type='session'),
    dcc.Store(id='selected-trade-store'),
    dcc.Interval(id='header-interval', interval=60000, n_intervals=0),
    dcc.Location(id='url', refresh=False),
    global_modals,
    dbc.Container([
        dbc.Row([
            # CAMBIO AQUI: Quitamos 'fw-bold' y agregamos 'fontWeight': 'normal'
            dbc.Col(html.H2("EDGE JOURNAL", className="my-4", style={"color": TEXT_MAIN, "fontWeight": "normal", "letterSpacing": "1px", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "textShadow": f"0 0 20px {COLOR_POS}33"}), width=8),
            dbc.Col([
                html.Div([
                    dbc.Button("CONFIG. ESTRATEGIA", id="open-config-btn", color="dark", className="me-3 fw-bold", style={"border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                    dbc.Button("SALIR", id="logout-btn", color="dark", outline=True, className="fw-bold", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": COLOR_NEUTRAL, "borderColor": BORDER_COLOR})
                ], id="header-actions", style={"display": "none"})
            ], width=4, className="mt-4 text-end")
        ]), 
        html.Div(id='page-content')
    ], fluid=True, style={"maxWidth": "1600px"})
], style={"backgroundColor": BG_COLOR, "minHeight": "100vh", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": TEXT_MAIN, "paddingBottom": "50px"})

app.validation_layout = html.Div([
    app.layout, 
    layout_login(), 
    layout_dashboard("User"), 
    global_modals, 
    get_management_panel(),
    # Componentes de Performance
    dcc.Graph(id="fig-perf-cumulative"),
    dcc.Graph(id="fig-perf-drawdown"),
    html.Div(id="perf-kpis-container"),
    html.Div(id="perf-status"),
    html.Button(id="btn-perf-ytd"),
    html.Button(id="btn-perf-yoy"),
    html.Button(id="btn-perf-all"),
    html.Button(id="btn-perf-2025"),
    html.Div(id="login-msg"),
    # Componentes de Aportes y Retiros
    dag.AgGrid(id="cash-movements-grid"),
    dbc.Input(id="cm-date"),
    dbc.Input(id="cm-amount"),
    dbc.Select(id="cm-type"),
    dbc.Button(id="btn-add-cm"),
    dbc.Button(id="btn-del-cm"),
    html.Div(id="cm-msg"),
    # Componentes de diagnóstico de valuación
    dbc.Button(id="btn-export-daily"),
    dcc.Download(id="download-daily"),
    dcc.Store(id="perf-daily-store"),
    # Collapse de aportes y retiros
    dbc.Button(id="btn-toggle-cm"),
    dbc.Collapse(id="collapse-cm"),
    # Toggle $/% de posiciones activas
    dbc.RadioItems(id="pnl-mode-toggle"),
    # Benchmark y moneda
    dbc.Select(id="benchmark-selector"),
    dcc.Store(id="perf-period-store"),
    dbc.Select(id="conf-currency"),
    dcc.Interval(id="perf-autoload"),
])
# --- CALLBACKS CORE ---
@app.callback([Output('page-content', 'children'), Output('header-actions', 'style')], [Input('session-store', 'data')])
def render_page(s):
    logged_in = bool(s and 'user' in s)
    # Los botones del header (CONFIG. ESTRATEGIA / SALIR) solo se ven con sesión activa
    return (layout_dashboard(s['user']) if logged_in else layout_login()), ({"display": "block"} if logged_in else {"display": "none"})

@app.callback(Output('header-pills', 'children'), [Input('header-interval', 'n_intervals'), Input('session-store', 'data')])
def update_header_pills(_n, s):
    if not s or 'user' not in s:
        return []
    df = db.get_open_trades(s['user'])
    if df.empty:
        return []
    symbols = df['symbol'].dropna().unique().tolist()
    if not symbols:
        return []
    pills = []
    try:
        raw = yf.download(symbols, period="2d", progress=False, auto_adjust=True)
        closes = raw['Close'] if 'Close' in raw else raw
        for sym in symbols:
            try:
                if isinstance(closes, pd.Series):
                    prices = closes
                elif sym in closes.columns:
                    prices = closes[sym].dropna()
                else:
                    continue
                if prices.empty:
                    continue
                current = float(prices.iloc[-1])
                if len(prices) >= 2:
                    prev = float(prices.iloc[-2])
                    pct = (current - prev) / prev * 100 if prev else 0
                    sign = "+" if pct >= 0 else ""
                    label = f"{sym}  {sign}{pct:.2f}%"
                    color = COLOR_POS if pct >= 0 else COLOR_NEG
                else:
                    label = f"{sym}  ${current:.2f}"
                    color = COLOR_NEUTRAL
                pills.append(html.Span(label, style={
                    "backgroundColor": f"{color}22",
                    "color": color,
                    "border": f"1px solid {color}55",
                    "borderRadius": "4px",
                    "padding": "2px 8px",
                    "fontSize": "0.72rem",
                    "fontFamily": "'Inter', 'Segoe UI', sans-serif",
                    "fontWeight": "bold",
                    "whiteSpace": "nowrap",
                    "letterSpacing": "0.5px"
                }))
            except Exception:
                continue
    except Exception as e:
        print(f"[ERROR] header pills: {e}")
    return pills

@app.callback(
    [Output('session-store', 'data'), Output('login-msg', 'children')],
    Input('login-btn', 'n_clicks'),
    [State('user-in', 'value'), State('pass-in', 'value')],
    prevent_initial_call=True
)
def handle_login(n_clicks, u, p):
    if n_clicks:
        if not u or not p:
            return no_update, "Ingresá usuario y contraseña."
        user = db.get_user(u)
        if not user or user.get('password_hash') != p:
            return no_update, "Usuario o contraseña incorrectos."
        return {'user': u, 'config': user.get('config', {})}, ""
    return no_update, no_update

@app.callback(Output('session-store', 'data', allow_duplicate=True), Input('logout-btn', 'n_clicks'), prevent_initial_call=True)
def handle_logout(n_clicks):
    if n_clicks: return {}
    return no_update

@app.callback([Output("modal-reg", "is_open"), Output("reg-msg", "children")], Input("open-reg", "n_clicks"), prevent_initial_call=True)
def open_reg_modal(n_open):
    if n_open: return True, ""
    return no_update, no_update

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

@app.callback([Output("modal-reg", "is_open", allow_duplicate=True), Output("reg-msg", "children", allow_duplicate=True)], [Input("close-reg", "n_clicks"), Input("do-reg", "n_clicks")], [State("reg-u", "value"), State("reg-p", "value"), State("reg-n", "value"), State("reg-e", "value"), State("tc-accept", "value")], prevent_initial_call=True)
def process_reg(n_close, n_do, user, password, name, email, tc_accepted):
    if ctx.triggered_id == "close-reg": return False, ""
    if ctx.triggered_id == "do-reg":
        if not user or not password: return True, "Faltan datos"
        if not email or not EMAIL_RE.match(str(email).strip()):
            return True, "Ingresá un email válido (lo vas a necesitar para recuperar tu contraseña)."
        if not tc_accepted: return True, "Debés aceptar los Términos y Condiciones para crear tu cuenta."
        success, msg = db.register_user(user, password, name or "", email)
        return (False, "") if success else (True, msg)
    return no_update, no_update

# --- MODAL TÉRMINOS Y CONDICIONES ---
@app.callback(Output("modal-tc", "is_open"), [Input("open-tc", "n_clicks"), Input("close-tc", "n_clicks")], State("modal-tc", "is_open"), prevent_initial_call=True)
def toggle_tc_modal(n_open, n_close, is_open):
    return not is_open

# --- RECUPERACIÓN DE CONTRASEÑA ---
@app.callback(
    [Output("modal-recovery", "is_open"), Output("rec-msg", "children"), Output("rec-msg", "style")],
    [Input("open-recovery", "n_clicks"), Input("close-recovery", "n_clicks"), Input("do-recovery", "n_clicks")],
    [State("rec-u", "value"), State("rec-e", "value"), State("rec-p1", "value"), State("rec-p2", "value")],
    prevent_initial_call=True
)
def process_recovery(n_open, n_close, n_do, user, email, p1, p2):
    msg_err = {"color": COLOR_NEG, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "minHeight": "20px"}
    msg_ok = {"color": COLOR_POS, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "minHeight": "20px"}
    trig = ctx.triggered_id
    if trig == "open-recovery":
        return True, "", msg_err
    if trig == "close-recovery":
        return False, "", msg_err
    if trig == "do-recovery":
        if not user or not email or not p1 or not p2:
            return True, "Completá todos los campos.", msg_err
        if p1 != p2:
            return True, "Las contraseñas no coinciden.", msg_err
        if len(p1) < 6:
            return True, "La contraseña nueva debe tener al menos 6 caracteres.", msg_err
        record = db.get_user(user)
        stored_email = (record or {}).get('email') or ""
        # Mensaje genérico si no coincide: no revelar si el usuario existe o cuál es su email
        if not record or not stored_email or stored_email.strip().lower() != str(email).strip().lower():
            return True, "Los datos no coinciden con ninguna cuenta recuperable.", msg_err
        if not db.update_user_password(user, p1):
            return True, "Error al actualizar la contraseña. Probá de nuevo.", msg_err
        return True, "✓ Contraseña actualizada. Ya podés iniciar sesión.", msg_ok
    return no_update, no_update, no_update

@app.callback([Output("modal-config", "is_open"), Output("conf-grid", "rowData"), Output("session-store", "data", allow_duplicate=True), Output("config-feedback", "children"), Output("conf-currency", "value")], [Input("open-config-btn", "n_clicks"), Input("close-config", "n_clicks"), Input("save-config", "n_clicks"), Input("add-row-btn", "n_clicks")], [State("modal-config", "is_open"), State("conf-grid", "rowData"), State("conf-currency", "value"), State("session-store", "data")], prevent_initial_call=True)
def config_modal(n1, n2, n3, n4, is_open, rows, currency, session):
    if not session: return False, [], no_update, "", no_update
    if ctx.triggered_id == "open-config-btn":
        data = [{"Parametro": k, "Opciones": ", ".join(v) if isinstance(v, list) else str(v)} for k, v in session.get('config', {}).items() if k not in RESERVED_CONFIG_KEYS]
        return True, data, no_update, "", session.get('config', {}).get('currency', 'USD')
    if ctx.triggered_id == "add-row-btn":
        return True, (rows or []) + [{"Parametro": "", "Opciones": ""}], no_update, "", no_update
    if ctx.triggered_id == "save-config":
        new_conf = {}
        if rows:
            for r in rows:
                param_raw = r.get("Parametro")
                param = str(param_raw).strip() if param_raw else ""

                opts_raw = r.get("Opciones")
                opts_str = str(opts_raw) if opts_raw else ""

                if param:
                    opts_list = [x.strip() for x in opts_str.split(",") if x.strip()]
                    new_conf[param] = opts_list

        if 'initial_balance' in session.get('config', {}):
            new_conf['initial_balance'] = session['config']['initial_balance']
        new_conf['currency'] = currency or 'USD'

        db.update_user_config(session['user'], new_conf)
        session['config'] = new_conf
        return False, no_update, session, "", no_update
    return False, no_update, no_update, "", no_update

@app.callback(Output('session-store', 'data', allow_duplicate=True), [Input('initial-balance-input', 'value')], [State('session-store', 'data')], prevent_initial_call=True)
def save_balance_change(bal, session):
    if not session or bal is None: return no_update
    if 'config' not in session: session['config'] = {}
    current_bal = session['config'].get('initial_balance', 10000)
    if float(bal) != current_bal:
        session['config']['initial_balance'] = float(bal)
        db.update_user_config(session['user'], session['config'])
        return session
    return no_update

def build_open_grid_cols(conf, mode="$"):
    """Columnas del grid de posiciones activas. mode '$' muestra PnL/Riesgo en
    valor absoluto; mode '%' los muestra en porcentaje sobre el costo de la posición."""
    dyn_cols = [{"field": k, "headerName": k, "width": 100} for k in conf.keys() if k not in RESERVED_CONFIG_KEYS] if isinstance(conf, dict) else []
    if mode == "%":
        pnl_col = {"field": "unrealized_pnl_pct", "headerName": "PnL (%)", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}}
        risk_col = {"field": "open_risk_pct", "headerName": "Riesgo (%)", "width": 90, "cellStyle": {'color': COLOR_NEG}}
    else:
        pnl_col = {"field": "unrealized_pnl", "headerName": f"PnL ({cur_sym(conf)})", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}}
        risk_col = {"field": "open_risk", "headerName": "Riesgo", "width": 90, "cellStyle": {'color': COLOR_NEG}}
    return [{"field": "id", "checkboxSelection": True, "width": 50}, {"field": "symbol", "width": 90}, {"field": "side", "width": 80, "cellStyle": {"styleConditions": [{"condition": "params.value=='LONG'", "style": {"color": COLOR_POS}}, {"condition": "params.value=='SHORT'", "style": {"color": COLOR_NEG}}]}}, {"field": "quantity", "headerName": "Qty", "width": 70}] + dyn_cols + [{"field": "entry_price", "headerName": "In", "width": 90}, {"field": "current_price", "headerName": "Live", "width": 90, "cellStyle": {'fontWeight': 'bold'}}, pnl_col, risk_col, {"field": "current_stop_loss", "headerName": "SL Act", "width": 90, "editable": True, "cellStyle": {'color': TEXT_MAIN, 'fontWeight': 'bold', 'backgroundColor': '#2B3139'}}]

def render_tab(tab, session):
    """Construye el contenido de una pestaña (función pura, sin callback)."""
    if not session: return html.Div()
    user, conf = session['user'], session.get('config', {})

    if tab == 'tab-active':
        df = db.get_open_trades(user)
        if not df.empty: df = calculate_live_metrics(df)
        dyn_inputs = []
        if isinstance(conf, dict):
            dyn_inputs.append(html.Hr(style={"borderColor": BORDER_COLOR}))
            row = []
            for p, opts in conf.items():
                if p not in RESERVED_CONFIG_KEYS and isinstance(opts, list): 
                    row.append(dbc.Col([dbc.Label(p, className="small fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Select(id={'type': 'strat-input', 'index': p}, options=[{"label": str(o), "value": str(o)} for o in opts], style=INPUT_STYLE)], width=3, className="mb-3"))
            for i in range(0, len(row), 4): dyn_inputs.append(dbc.Row(row[i:i+4]))
        
        cols = build_open_grid_cols(conf, "$")

        return dbc.Row([
            dbc.Col([
                dbc.Card([
                    dbc.CardHeader("NUEVA OPERACION", style={"backgroundColor": "transparent", "borderBottom": f"1px solid {BORDER_COLOR}", "fontWeight": "bold", "color": TEXT_MAIN}), 
                    dbc.CardBody([
                        dbc.Row([dbc.Col(dbc.Input(id="nt", placeholder="Ticker", style=INPUT_STYLE), width=3), dbc.Col(dbc.Select(id="ns", options=[{"label":"LONG","value":"LONG"},{"label":"SHORT","value":"SHORT"}], value="LONG", style=INPUT_STYLE), width=3), dbc.Col(dbc.Input(id="nq", placeholder="Qty", type="number", style=INPUT_STYLE), width=3), dbc.Col(dbc.Input(id="nd", type="date", value=date.today(), style=INPUT_STYLE), width=3)], className="mb-3"), 
                        dbc.Row([dbc.Col(dbc.Input(id="np", placeholder="Precio In", type="number", style=INPUT_STYLE), width=6), dbc.Col(dbc.Input(id="nsl", placeholder="SL Inicial", type="number", style=INPUT_STYLE), width=6)]),
                        html.Div("⚠  Stop Loss Inicial requerido para simulación de riesgo y cálculo de R", id="sl-warning", style={"display": "none"}),
                        html.Div(dyn_inputs), html.Hr(style={"borderColor": BORDER_COLOR}), 
                        
                        # --- NOTAS DE ENTRADA ---
                        dbc.Textarea(id="n-notes", placeholder="Notas de entrada...", style={"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "15px", "height": "80px"}),
                        
                        dbc.Button("EJECUTAR ORDEN", id="btn-new", color="light", className="w-100 mb-3 fw-bold text-dark", style={"border": "none", "padding": "12px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), 
                        dcc.Upload(id='upload-data', children=dbc.Button("IMPORTAR EXCEL", color="dark", outline=True, size="sm", className="w-100", style={"borderColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), multiple=False)
                    ])
                ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"}),
                get_management_panel()
            ], width=5), 
            dbc.Col([
                dbc.Row([
                    dbc.Col(html.H5("POSICIONES ACTIVAS", className="fw-bold mb-3", style={"color": TEXT_MAIN}), width=8),
                    dbc.Col(dbc.RadioItems(
                        id="pnl-mode-toggle",
                        options=[{"label": "$", "value": "$"}, {"label": "%", "value": "%"}],
                        value="$",
                        inline=True,
                        className="btn-group",
                        inputClassName="btn-check",
                        labelClassName="btn btn-sm btn-outline-secondary fw-bold",
                        labelCheckedClassName="active",
                        style={"fontFamily": "'Inter', 'Segoe UI', sans-serif"}
                    ), width=4, className="text-end")
                ]),
                html.Div(dag.AgGrid(id="open-grid", rowData=format_df(df, conf), columnDefs=cols, dashGridOptions={"rowSelection": "single", "pagination": True, "paginationPageSize": 10}, className="ag-theme-alpine-dark", style={"height": "350px", "width": "100%", **CUSTOM_GRID_STYLE}), style={"borderRadius": "4px", "overflow": "hidden", "border": "none", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"}),
                html.Hr(style={"borderColor": BORDER_COLOR, "margin": "30px 0"}),
                dbc.Row([
                    dbc.Col(html.H5("EXPOSICION ACTUAL", className="fw-bold mb-3", style={"color": TEXT_MAIN}), width=8),
                    dbc.Col(dcc.Dropdown(id='live-chart-mode-selector', options=[{'label': 'TOTAL PORTFOLIO', 'value': 'TOTAL'}, {'label': 'POR ACTIVO', 'value': 'SYMBOL'}], value='TOTAL', clearable=False, style=DROPDOWN_STYLE), width=4)
                ]),
                html.Div(dcc.Graph(id="fig-live-risk", style={'height': '300px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"})
            ], width=7)
        ])

    elif tab == 'tab-history':
        df = db.get_closed_trades(user)
        df = add_pnl_pct(df)

        if not df.empty and 'exit_date' in df.columns:
            df = df.sort_values('exit_date', ascending=True)
            df['visual_id'] = range(1, len(df) + 1)
            df = df.sort_values('exit_date', ascending=False)
        else:
            df['visual_id'] = []
            
        dyn_cols = [{"field": k, "headerName": k, "width": 100} for k in conf.keys() if k not in RESERVED_CONFIG_KEYS] if isinstance(conf, dict) else []
        cols = [{"field": "id", "checkboxSelection": True, "width": 50}, {"field": "visual_id", "headerName": "#", "width": 60, "sortable": True}, {"field": "entry_date", "width": 100}, {"field": "symbol", "width": 90}, {"field": "side", "width": 80, "cellStyle": {"styleConditions": [{"condition": "params.value=='LONG'", "style": {"color": COLOR_POS}}, {"condition": "params.value=='SHORT'", "style": {"color": COLOR_NEG}}]}}, {"field": "quantity", "headerName": "Qty", "width": 80}, {"field": "result_type", "width": 70}, {"field": "entry_price", "width": 90}, {"field": "exit_price", "width": 90}, {"field": "initial_stop_loss", "width": 80}, {"field": "current_stop_loss", "width": 80}] + dyn_cols + [{"field": "rr", "headerName": "R", "width": 80}, {"field": "pnl", "headerName": "PnL", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}}, {"field": "pnl_pct", "headerName": "PnL %", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}},
                # --- NOTAS ---
                {"field": "entry_notes", "headerName": "Notas Entrada", "width": 200, "editable": True, "cellEditor": "agLargeTextCellEditor"},
                {"field": "exit_notes", "headerName": "Notas Salida", "width": 200, "editable": True, "cellEditor": "agLargeTextCellEditor"},
                {"field": "exit_date", "width": 100}]
        
        return html.Div([
            dbc.Row([
                dbc.Col(dbc.Button("BORRAR SELECCION", id="btn-del-sel-hist", color="dark", className="me-2 fw-bold", style={"border": f"1px solid {BORDER_COLOR}", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), width="auto"), 
                
                # --- BOTON PELIGROSO ---
                dbc.Col(
                    dbc.Accordion([
                        dbc.AccordionItem([
                            dcc.ConfirmDialogProvider(
                                children=dbc.Button("BORRAR BASE DE DATOS", id="btn-del-all-hist", color="danger", className="fw-bold w-100", style={"backgroundColor": "red", "color": "white", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                                id="confirm-del-all", message="⚠️ ¡CUIDADO! ¿Eliminar todo el historial? Esta acción NO se puede deshacer."
                            )
                        ], title="⚠️ BORRAR BD COMPLETA")
                    ], start_collapsed=True, flush=True, style={"minWidth": "300px"}), width="auto"
                ),
                
                dbc.Col(html.Div(id="hist-msg", className="small mt-2 fw-bold", style={"color": TEXT_MAIN}), width="auto")
            ], className="mb-4 align-items-center"), 
            html.Div(dag.AgGrid(id="history-grid", rowData=format_df(df, conf), columnDefs=cols, dashGridOptions={"rowSelection": "single", "pagination": True, "paginationPageSize": 25, "paginationPageSizeSelector": [10, 25, 50, 100]}, className="ag-theme-alpine-dark", style={"height": "650px", "width": "100%", **CUSTOM_GRID_STYLE}), style={"borderRadius": "4px", "overflow": "hidden", "border": "none", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"})
        ])

    elif tab == 'tab-analytics':
        strategy_options = [{"label": k, "value": k} for k in conf.keys() if k not in RESERVED_CONFIG_KEYS] if isinstance(conf, dict) else []
        default_val = strategy_options[0]['value'] if strategy_options else None
        saved_bal = conf.get('initial_balance', 10000)
        
        return html.Div([
            dbc.Row([
                dbc.Col(html.H4("METRICAS DE SISTEMA", style={"color": TEXT_MAIN, "marginTop": "20px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), width=9),
                dbc.Col(dbc.InputGroup([dbc.InputGroupText(f"CAPITAL INICIAL ({cur_sym(conf)})", style={"backgroundColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "border": "none", "fontWeight": "bold", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "fontSize": "12px"}), dbc.Input(id="initial-balance-input", type="number", value=saved_bal, debounce=True, style=INPUT_STYLE)]), width=3)
            ], className="mb-4 align-items-center"),
            dcc.Loading(id="loading-analytics", type="default", color=COLOR_NEUTRAL, children=html.Div([
                html.Div(id="kpi-container", className="mb-4"),
                dbc.Row([
                    dbc.Col([
                        html.Div(dcc.Graph(id="fig-equity"), style={"borderRadius": "4px 4px 0 0", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "borderBottom": "none"}), 
                        html.Div(dcc.Graph(id="fig-dd"), style={"borderRadius": "0 0 4px 4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "borderTop": "none"})
                    ], width=8), 
                    dbc.Col([
                        html.Div(dcc.Graph(id="fig-portfolio", style={'height': '280px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "marginBottom": "15px", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), 
                        html.Div(dcc.Graph(id="fig-hist", style={'height': '380px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"})
                    ], width=4)
                ], className="mb-4"),
                
                dbc.Row([
                    dbc.Col(html.Div(dcc.Graph(id="fig-evo-winrate", style={'height': '350px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=4),
                    dbc.Col(html.Div(dcc.Graph(id="fig-evo-ratio", style={'height': '350px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=4),
                    dbc.Col(html.Div(dcc.Graph(id="fig-edge", style={'height': '350px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=4)
                ], className="mb-4"),

                html.Hr(style={"borderColor": BORDER_COLOR}), 
                dbc.Row([dbc.Col([html.Label("ATRIBUCION POR PARAMETRO:", className="fw-bold mb-2", style={"color": COLOR_NEUTRAL, "letterSpacing": "1px", "fontSize": "0.8rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), dcc.Dropdown(id='strategy-selector', options=strategy_options, value=default_val, clearable=False, style=DROPDOWN_STYLE)], width=4, className="mb-4")]),
                dbc.Row([dbc.Col(html.Div(dcc.Graph(id="fig-strategy"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6), dbc.Col(html.Div(dcc.Graph(id="fig-count"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6)])
            ]))
        ])

    elif tab == 'tab-montecarlo':
        return html.Div([
            dbc.Row([
                dbc.Col([html.H4("SIMULADOR DE MONTECARLO", style={"color": TEXT_MAIN, "marginTop": "20px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), html.P("Generador de escenarios  basado en distr. de R.", className="text-muted"), html.P("Se recomienda un mínimo de 50/100 operaciones para realizar la simulación.", style={"color": COLOR_NEUTRAL, "fontSize": "0.78rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginTop": "-8px"})], width=6),
                dbc.Col([dbc.Label("N° Iteraciones", className="fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Input(id="mc-n-sim", type="number", value=3000, min=100, max=10000, style=INPUT_STYLE)], width=3),
                dbc.Col([dbc.Label("Kelly Fraction (f*)", className="fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Input(id="mc-kelly-frac", type="number", value=1.0, min=0.1, max=2.0, step=0.01, style=INPUT_STYLE)], width=3),
            ], className="mb-4 align-items-center"),
            dbc.Button("INICIAR SIMULACION", id="btn-run-mc", color="light", className="w-100 mb-5 fw-bold p-3 text-dark", style={"border": "none", "borderRadius": "4px", "fontSize": "1.1rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
            dcc.Loading(id="loading-mc", type="default", color=COLOR_NEUTRAL, children=html.Div(id="mc-results-container", style={'display': 'none'}, children=[
                html.Div(id="mc-kpi-container", className="mb-4"),
                dbc.Row([
                    dbc.Col(html.Div(dcc.Graph(id="fig-mc-curves"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=8),
                    dbc.Col(html.Div(dcc.Graph(id="fig-kelly-curve"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=4)
                ], className="mb-4"),
                
                dbc.Row([
                    dbc.Col(html.Div(dcc.Graph(id="fig-mc-ret"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6),
                    dbc.Col(html.Div(dcc.Graph(id="fig-mc-dd"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6)
                ])
            ]))
        ])
    
    elif tab == 'tab-performance':
        # Leer capital inicial de la config (mismo que Analytics)
        saved_bal = conf.get('initial_balance', 10000)
        df_cm = db.get_cash_movements(user)
        cm_data = df_cm.to_dict("records") if not df_cm.empty else []

        return dbc.Container([
            # Título
            dbc.Row([
                dbc.Col(html.H4("RETORNO ACUMULADO DEL PORTFOLIO", 
                               style={"color": TEXT_MAIN, "marginTop": "20px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}))
            ]),
            
            # Controles: botones de periodo + benchmark + indicador de capital
            dbc.Row([
                dbc.Col([
                    html.Label("Período:", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "5px", "display": "block"}),
                    dbc.ButtonGroup([
                        dbc.Button("YTD", id="btn-perf-ytd", color="dark", outline=True, size="sm", style=PERF_BTN_STYLE),
                        dbc.Button("YoY", id="btn-perf-yoy", color="dark", outline=True, size="sm", style=PERF_BTN_STYLE),
                        dbc.Button("ALL DATA", id="btn-perf-all", color="dark", outline=True, size="sm", style=PERF_BTN_STYLE),
                        dbc.Button("2025", id="btn-perf-2025", color="dark", outline=True, size="sm", style=PERF_BTN_STYLE),
                    ], size="sm")
                ], width=3),

                dbc.Col([
                    html.Label("Benchmark:", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "5px", "display": "block"}),
                    dbc.Select(
                        id="benchmark-selector",
                        options=[
                            {"label": "SPY (US$)", "value": "SPY"},
                            {"label": "SPY CEDEAR (AR$)", "value": "SPY.BA"},
                            {"label": "MERVAL (AR$)", "value": "^MERV"}
                        ],
                        value="SPY.BA" if conf.get('currency') == 'ARS' else "SPY",
                        size="sm",
                        style=INPUT_STYLE
                    )
                ], width=2),

                dbc.Col([
                    html.Div([
                        html.Span("Capital Inicial: ", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}),
                        html.Span(f"{cur_sym(conf)}{saved_bal:,.0f}", style={"color": TEXT_MAIN, "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "fontWeight": "bold"}),
                        html.Span(" (config Analytics)", style={"color": COLOR_NEUTRAL, "fontSize": "0.7rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginLeft": "5px"}),
                    ], style={"paddingTop": "25px"})
                ], width=2),

                dbc.Col([
                    html.Div(id="perf-status", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "paddingTop": "25px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"})
                ], width=3),

                dbc.Col([
                    html.Div(style={"height": "20px"}),  # Spacer
                    dbc.Button(
                        "EXPORTAR CSV",
                        id="btn-export-daily",
                        color="dark", outline=True, size="sm",
                        style={"fontFamily": "'Inter', 'Segoe UI', sans-serif", "fontWeight": "bold", "borderColor": BORDER_COLOR, "color": COLOR_NEUTRAL}
                    ),
                    dcc.Download(id="download-daily"),
                    dcc.Store(id="perf-daily-store"),
                    dcc.Store(id="perf-period-store"),
                    # Dispara el cálculo automáticamente al entrar a la pestaña
                    dcc.Interval(id="perf-autoload", interval=400, n_intervals=0, max_intervals=1)
                ], width=2)
            ], style={"marginTop": "15px", "marginBottom": "20px"}),

            # Resultados con spinner mientras corre el cálculo de Performance
            dcc.Loading(id="loading-performance", type="default", color=COLOR_NEUTRAL, children=html.Div([
                # KPIs resumen
                html.Div(id="perf-kpis-container", style={"marginBottom": "25px"}),

                # Gráfico principal: Retorno Acumulado
                dbc.Row([
                    dbc.Col([
                        dcc.Graph(
                            id="fig-perf-cumulative",
                            config={'displayModeBar': False},
                            style={"height": "450px"},
                            figure={"layout": {"paper_bgcolor": CARD_BG, "plot_bgcolor": CARD_BG,
                                               "xaxis": {"visible": False}, "yaxis": {"visible": False},
                                               "font": {"color": COLOR_NEUTRAL}}}
                        )
                    ], width=12)
                ]),

                # Gráfico secundario: Drawdown %
                dbc.Row([
                    dbc.Col([
                        dcc.Graph(
                            id="fig-perf-drawdown",
                            config={'displayModeBar': False},
                            style={"height": "250px"},
                            figure={"layout": {"paper_bgcolor": CARD_BG, "plot_bgcolor": CARD_BG,
                                               "xaxis": {"visible": False}, "yaxis": {"visible": False},
                                               "font": {"color": COLOR_NEUTRAL}}}
                        )
                    ], width=12)
                ], style={"marginTop": "10px"})
            ])),

            # Tablero de aportes y retiros (colapsable, cerrado por default)
            dbc.Card([
                dbc.CardHeader(
                    dbc.Button(
                        "▸ APORTES Y RETIROS",
                        id="btn-toggle-cm",
                        color="link",
                        className="p-0 text-decoration-none fw-bold",
                        style={"color": TEXT_MAIN, "fontFamily": "'Inter', 'Segoe UI', sans-serif", "letterSpacing": "0.5px"}
                    ),
                    style={"backgroundColor": "transparent", "borderBottom": "none"}
                ),
                dbc.Collapse(
                    dbc.CardBody([
                        dbc.Row([
                            dbc.Col(dbc.Input(id="cm-date", type="date", value=date.today(), style=INPUT_STYLE), width=3),
                            dbc.Col(dbc.Input(id="cm-amount", placeholder="Monto ($)", type="number", min=0, style=INPUT_STYLE), width=3),
                            dbc.Col(dbc.Select(id="cm-type", options=[{"label": "APORTE", "value": "APORTE"}, {"label": "RETIRO", "value": "RETIRO"}], value="APORTE", style=INPUT_STYLE), width=3),
                            dbc.Col(dbc.Button("AGREGAR", id="btn-add-cm", color="light", className="w-100 fw-bold text-dark", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif", "border": "none"}), width=3)
                        ], className="mb-3"),
                        dag.AgGrid(
                            id="cash-movements-grid",
                            columnDefs=[
                                {"field": "id", "checkboxSelection": True, "width": 70},
                                {"field": "movement_date", "headerName": "Fecha", "width": 130},
                                {"field": "amount", "headerName": "Monto ($)", "width": 130},
                                {"field": "movement_type", "headerName": "Tipo", "flex": 1, "cellStyle": {"styleConditions": [
                                    {"condition": "params.value=='APORTE'", "style": {"color": COLOR_POS}},
                                    {"condition": "params.value=='RETIRO'", "style": {"color": COLOR_NEG}}
                                ]}}
                            ],
                            rowData=cm_data,
                            dashGridOptions={"rowSelection": "single", "pagination": True, "paginationPageSize": 10},
                            className="ag-theme-alpine-dark",
                            style={"height": "220px", "width": "100%", **CUSTOM_GRID_STYLE}
                        ),
                        dbc.Row([
                            dbc.Col(dbc.Button("ELIMINAR SELECCION", id="btn-del-cm", color="dark", size="sm", style={"fontFamily": "'Inter', 'Segoe UI', sans-serif", "border": f"1px solid {BORDER_COLOR}"}), width="auto"),
                            dbc.Col(html.Div(id="cm-msg", style={"color": COLOR_NEUTRAL, "fontSize": "0.85rem", "paddingTop": "5px", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}), width="auto")
                        ], className="mt-2")
                    ], style={"backgroundColor": CARD_BG}),
                    id="collapse-cm",
                    is_open=False
                )
            ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)", "marginTop": "25px", "marginBottom": "25px"})

        ], fluid=True, style={"backgroundColor": BG_COLOR, "minHeight": "100vh", "padding": "20px"})
    
    elif tab == 'tab-info':
        return html.Div([
            dbc.Row([
                dbc.Col([
                    html.H3("MANUAL DE USUARIO", className="mb-4", style={"color": TEXT_MAIN, "letterSpacing": "1px"}),
                    
                    # --- SECCION 1: OBJETIVOS ---
                    dbc.Card([
                        dbc.CardHeader("OBJETIVO DEL SITIO", style={"fontWeight": "bold", "color": TEXT_MAIN}),
                        dbc.CardBody([
                            html.P("Edge Journal es una plataforma de registro y análisis de operatoria bursátil diseñada para:", className="card-text"),
                            html.Ul([
                                html.Li("Registrar operaciones realizadas y posiciones abiertas en distintos activos financieros."),
                                html.Li("Analizar el desempeño de la operatoria mediante distintos indicadores de performance claves."),
                                html.Li("Determinar el nivel de riesgo óptimo utilizando el Criterio de Kelly y combinarlo con simulaciones de Montecarlo para obtener la distribución de retornos y máximo drawdown de los distintos escenarios que se pueden dar en base a nuestras métricas operativas y, en base a eso, determinar un nivel de riesgo por posición que se adapte a nuestros objetivos.")
                            ])
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "marginBottom": "20px"}),

                    # --- SECCION 2: FORMATO EXCEL ---
                    dbc.Card([
                        dbc.CardHeader("IMPORTACIÓN DE EXCEL (FORMATO REQUERIDO)", style={"fontWeight": "bold", "color": COLOR_POS}),
                        dbc.CardBody([
                            html.P("Si se desea importar un historial de operaciones, tu archivo (.csv o .xlsx) debe contener las siguientes columnas (no importa el orden):", className="card-text"),
                            
                            dbc.Table([
                                html.Thead(html.Tr([html.Th("Columna"), html.Th("Descripción"), html.Th("Ejemplo")])),
                                html.Tbody([
                                    html.Tr([html.Td("SYMBOL"), html.Td("Símbolo del activo operado"), html.Td("AAPL, EURUSD, BTC")]),
                                    html.Tr([html.Td("SIDE"), html.Td("Dirección de la operación"), html.Td("LONG / SHORT")]),
                                    html.Tr([html.Td("QTY / QUANTITY"), html.Td("Cantidad de contratos/acciones"), html.Td("10, 100")]),
                                    html.Tr([html.Td("Entry_price"), html.Td("Precio de entrada promedio"), html.Td("150.50")]),
                                    html.Tr([html.Td("Exit_price"), html.Td("Precio de salida (Opcional, si está cerrado)"), html.Td("155.00")]),
                                    html.Tr([html.Td("Initial_stop_loss"), html.Td("Stop Loss inicial (Vital para cálculo de R)"), html.Td("148.00")]),
                                    html.Tr([html.Td("Entry_date"), html.Td("Fecha de entrada (YYYY-MM-DD)"), html.Td("2023-10-25")]),
                                    html.Tr([html.Td("Exit_date"), html.Td("Fecha de salida (YYYY-MM-DD)"), html.Td("2023-10-25")]),
                                    html.Tr([html.Td("RESULTADO"), html.Td("Estado final (WIN / LOSS / BE)"), html.Td("WIN")])
                                ])
                            ], bordered=True, hover=True, style={"fontSize": "0.9rem"}),
                            
                            dbc.Alert([
                                html.I(className="bi bi-info-circle-fill me-2"),
                                "NOTA: Cualquier otra columna que agregues (ej: 'Setup', 'Emocion', 'Timeframe') será detectada automáticamente como un parámetro de tu estrategia y se agregará a los filtros de Analytics."
                            ], color="info", style={"backgroundColor": "rgba(0, 176, 189, 0.1)", "border": f"1px solid {COLOR_POS}", "color": TEXT_MAIN})
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "marginBottom": "20px"}),
                ], width=6),

                dbc.Col([
                    # --- SECCION 3: GUIA DE PESTAÑAS ---
                    dbc.Card([
                        dbc.CardHeader("GUÍA DE NAVEGACIÓN", style={"fontWeight": "bold", "color": TEXT_MAIN}),
                        dbc.CardBody([
                            dbc.Accordion([
                                dbc.AccordionItem([
                                    html.P("Panel de control diario. Aquí puedes:"),
                                    html.Ul([
                                        html.Li("Ingresar nuevos trades manuales."),
                                        html.Li("Ver el PnL no realizado y riesgo activo de las posiciones abiertas."),
                                        html.Li("Gestionar posiciones: Cierre total o parcial de posición, mover SL o eliminar operación."),
                                        html.Li("Importar historial operativo de excel.")
                                    ])
                                ], title="1. OPERATIVA"),
                                
                                dbc.AccordionItem([
                                    html.P("Base de datos de operaciones cerradas."),
                                    html.Ul([
                                        html.Li("Ver tabla completa de historial."),
                                        html.Li("Editar notas de entrada y salida."),
                                        html.Li("Eliminar registros erróneos o borrar toda la base de datos (Admin).")
                                    ])
                                ], title="2. HISTORIAL"),
                                
                                dbc.AccordionItem([
                                    html.P("Análisis de operatoria a través de métricas operativas:"),
                                    html.Ul([
                                        html.Li("Visualizar Curva de Equity y Drawdown."),
                                        html.Li("Analizar evolución de Win Rate y Ratio R/B. Visualizar si nuestro sistema tiene un edge cercano al break even o se puede considerar que el sistema tiene un edge positivo."),
                                        html.Li("Filtrar métricas por parámetros de estrategia."),
                                        html.Li("Visualizar la distribución de resultados: Una curva de distribución con asimetría positiva indica una gestión controlada de operaciones perdedoras y que se deja correr las operaciones ganadoras.")
                                    ])
                                ], title="3. ANALYTICS"),
                                
                                dbc.AccordionItem([
                                    html.P("Esta pestaña permite determinar un nivel de riesgo por posición que se adapte a nuestros objetivos pero que a la vez tenga un criterio matemático detrás que permita maximizar retornos y conocer los máximos drawdowns potenciales para cada nivel de riesgo elegido:"),
                                    html.Ul([
                                        html.Li("Cálculo de fracción óptima de riesgo (f de Kelly) que maximiza retornos geométricos."),
                                        html.Li("Simulaciones de Montecarlo para conocer la distribución de retornos y máximo drawdown de los distintos escenarios que se pueden dar en base a nuestras métricas operativas y, en base a eso, determinar un nivel de riesgo por posición que se adapte a nuestros objetivos.")
                                    ])
                                ], title="4. SIMULADOR DE RIESGO"),

                                dbc.AccordionItem([
                                    html.P("Análisis del rendimiento del portfolio en perspectiva, con el SPY como benchmark de referencia:"),
                                    html.Ul([
                                        html.Li("Comparar la curva de retorno acumulado del portfolio contra el SPY en distintos períodos de tiempo (YTD, por año, histórico)."),
                                        html.Li("Evaluar métricas de retorno ajustado por riesgo: Sharpe Ratio, Sortino Ratio, Calmar Ratio, Jensen Alpha para determinar la calidad del rendimiento más allá del retorno."),
                                        html.Li("Analizar la evolución del drawdown máximo porcentual para medir la consistencia del sistema y su capacidad de preservación de capital.")
                                    ])
                                ], title="5. PERFORMANCE")
                            ], start_collapsed=True, flush=True)
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "marginBottom": "20px"}),

                    # --- SECCION 4: GLOSARIO ---
                    dbc.Card([
                        dbc.CardHeader("GLOSARIO Y FÓRMULAS", style={"fontWeight": "bold", "color": COLOR_NEUTRAL}),
                        dbc.CardBody([
                            dbc.Accordion([
                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Resultado neto monetario de una operación cerrada."]),
                                    html.P([html.B("Long:"), " (P. Salida - P. Entrada) * Cantidad"]),
                                    html.P([html.B("Short:"), " (P. Entrada - P. Salida) * Cantidad"])
                                ], title="PnL (Profit and Loss)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Medida estandarizada del riesgo inicial asumido en una operación."]),
                                    html.P([html.B("Cálculo:"), " 1R = |Precio Entrada - Stop Loss|"]),
                                    html.P("Permite comparar el desempeño de operaciones con distintos precios y volatilidades.")
                                ], title="Unidad de Riesgo (RR)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Win Rate:"), " % de operaciones ganadoras respecto al total (sin contar Break Even)."]),
                                    html.P([html.B("Loss Rate:"), " % de operaciones perdedoras respecto al total (sin contar Break Even)."])
                                ], title="Win Rate / Loss Rate"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Relación entre ganancia promedio y pérdida promedio (Payoff Ratio)."]),
                                    html.P([html.B("Fórmula:"), " B = Avg Win ($) / |Avg Loss ($)|"])
                                ], title="Ratio Riesgo/Beneficio Histórico"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Valor promedio esperado por cada operación a largo plazo."]),
                                    html.P("Si es positiva, el sistema es rentable."),
                                    html.P([html.B("Fórmula:"), " E(x) = (WinRate * AvgWin) - (LossRate * AvgLoss)"])
                                ], title="Esperanza Matemática E(x)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Porcentaje teórico de capital a arriesgar para maximizar el crecimiento geométrico."]),
                                    html.P([html.B("Fórmula:"), " K% = (W * (B + 1) - 1) / B, B=payoff average historico , W=Winrate"])
                                ], title="Criterio de Kelly"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Mayor caída porcentual desde un pico histórico hasta un valle."]),
                                    html.P([html.B("Fórmula:"), " (Valle - Pico Previo) / Pico Previo"])
                                ], title="Máximo Drawdown (MDD)"),

                                # --- NUEVOS CONCEPTOS INSTITUCIONALES ---
                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Mide el rendimiento adicional generado por cada unidad de riesgo (volatilidad total) asumida."]),
                                    html.P([html.B("Fórmula:"), " (Retorno Anualizado - Tasa Libre de Riesgo) / Desviación Estándar de los Retornos."]),
                                    html.P("Un Sharpe superior a 1.0 se considera bueno; mayor a 2.0 es excelente.")
                                ], title="Sharpe Ratio"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Similar al Sharpe Ratio, pero solo penaliza la volatilidad negativa (caídas). No castiga los picos de ganancias."]),
                                    html.P([html.B("Fórmula:"), " (Retorno Anualizado - Tasa Libre de Riesgo) / Desviación Estándar de Retornos a la baja."]),
                                    html.P("Suele ser más representativo para traders que buscan asimetría positiva en sus retornos.")
                                ], title="Sortino Ratio"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Mide el retorno anualizado obtenido por cada unidad de drawdown máximo asumido. Relaciona directamente la rentabilidad con el peor escenario de pérdida experimentado."]),
                                    html.P([html.B("Fórmula:"), " Retorno Anualizado / |Máximo Drawdown %|"]),
                                    html.P("Un Calmar superior a 1.0 indica que el portafolio generó más retorno anualizado del que sufrió en su peor caída. Valores más altos reflejan mejor control del riesgo de ruina.")
                                ], title="Calmar Ratio"),

                                dbc.AccordionItem([
                                    html.P([html.B("Beta (β):"), " Sensibilidad del portafolio frente al mercado (SPY). Un β de 1.2 significa que el portafolio es un 20% más volátil que el SPY."]),
                                    html.P([html.B("Alpha de Jensen (α):"), " Mide el exceso de retorno que genera una inversión o portfolio en comparación con el retorno esperado según el CAPM. Mide la verdadera habilidad del operador."]),
                                    html.P([html.B("Fórmula Alpha:"), " (Retorno del Portafolio - Tasa Libre) - [ Beta * (Retorno del Mercado - Tasa Libre) ]"])
                                ], title="Alpha de Jensen & Beta"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Tiempo (medido en días) que el portafolio pasa en estado de Drawdown."]),
                                    html.P("Cuenta los días desde que el capital cae por debajo de su último máximo histórico hasta que logra superarlo nuevamente."),
                                    html.P("Es una medida psicológica clave para entender la paciencia y disciplina requerida por un sistema.")
                                ], title="Time Under Water (TUW)"),
                                # ----------------------------------------

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Límite del 'peor escenario razonable' (95% de confianza) arrojado por la simulación de Montecarlo."]),
                                    html.P("Indica que en el 95% de las iteraciones simuladas, el Drawdown del sistema no superó este nivel de caída.")
                                ], title="Value at Risk (VaR 95%)"),
                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Porcentaje de escenarios simulados en los que la equity del portfolio llega a cero, es decir, pérdida total del capital."]),
                                    html.P([html.B("Fórmula:"), " (N° de equity curves que alcanzan 0 / N° total de simulaciones) * 100"]),
                                    html.P("Un riesgo de ruina del 1% significa que en 1 de cada 100 escenarios simulados, el operador pierde la totalidad de su capital. Es una métrica clave para evaluar si la fracción de Kelly elegida es viable en la práctica.")
                                ], title="Riesgo de Ruina"),

                            ], start_collapsed=True, flush=True)
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}"})
                ], width=6)
            ]),
            dbc.Row([
                dbc.Col(html.Div([
                    html.Hr(style={"borderColor": BORDER_COLOR, "marginTop": "40px"}),
                    html.P("Desarrollado por Mirko Gulin", style={"color": COLOR_NEUTRAL, "fontSize": "0.9rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "textAlign": "center", "marginBottom": "5px"}),
                    html.P(html.A("mirkogulin2001@gmail.com", href="mailto:mirkogulin2001@gmail.com", style={"color": COLOR_POS, "textDecoration": "none"}), style={"textAlign": "center", "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "marginBottom": "15px"}),
                    html.P([
                        "Visitá ",
                        html.A("Edge Terminal", href="https://edge-terminal.streamlit.app/", target="_blank", style={"color": COLOR_POS, "textDecoration": "none", "fontWeight": "bold"}),
                        " y mejorá tus análisis"
                    ], style={"textAlign": "center", "fontSize": "0.85rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "color": TEXT_MAIN, "marginBottom": "10px"}),
                    html.P("© 2026 Edge Journal", style={"color": BORDER_COLOR, "fontSize": "0.75rem", "fontFamily": "'Inter', 'Segoe UI', sans-serif", "textAlign": "center", "marginBottom": "0"})
                ], style={"padding": "20px 0 30px 0"}), width=12)
            ])
        ])
    return html.Div()

# --- NAVEGACIÓN SPA: paneles persistentes por pestaña ---

# 1) Cambio de visibilidad instantáneo en el navegador (cero servidor)
app.clientside_callback(
    """
    function(tab) {
        const tabs = ['tab-active','tab-history','tab-analytics','tab-montecarlo','tab-performance','tab-info'];
        return tabs.map(t => t === tab ? {'display': 'block'} : {'display': 'none'});
    }
    """,
    [Output(f"pane-{t}", "style") for t in TAB_IDS],
    Input("tabs", "value")
)

# 2) Render perezoso: cada pestaña se construye en el servidor SOLO la primera
#    vez que se visita (o tras un cambio de sesión/config, que resetea todo).
@app.callback(
    [Output(f"pane-{t}", "children") for t in TAB_IDS] + [Output('rendered-tabs-store', 'data')],
    [Input('tabs', 'value'), Input('session-store', 'data')],
    State('rendered-tabs-store', 'data')
)
def populate_tab(tab, session, rendered):
    if not session:
        return [html.Div() for _ in TAB_IDS] + [[]]
    rendered = rendered or []
    if ctx.triggered_id == 'session-store' or not rendered:
        # Login o cambio de config: renderizar la pestaña activa y limpiar el resto
        outs = [render_tab(t, session) if t == tab else html.Div() for t in TAB_IDS]
        return outs + [[tab]]
    if tab in rendered:
        return [no_update for _ in TAB_IDS] + [no_update]
    outs = [render_tab(t, session) if t == tab else no_update for t in TAB_IDS]
    return outs + [rendered + [tab]]

# 3) Refresco de datos en segundo plano al volver a una pestaña ya montada
#    (el panel aparece instantáneo con los datos previos y el grid se actualiza detrás)
@app.callback(Output('open-grid', 'rowData', allow_duplicate=True), Input('tabs', 'value'), State('session-store', 'data'), prevent_initial_call=True)
def refresh_open_grid_on_tab(tab, session):
    if tab != 'tab-active' or not session: return no_update
    df = db.get_open_trades(session['user'])
    if not df.empty: df = calculate_live_metrics(df)
    return format_df(df, session.get('config', {}))

@app.callback(Output('history-grid', 'rowData', allow_duplicate=True), Input('tabs', 'value'), State('session-store', 'data'), prevent_initial_call=True)
def refresh_history_grid_on_tab(tab, session):
    if tab != 'tab-history' or not session: return no_update
    df = db.get_closed_trades(session['user'])
    df = add_pnl_pct(df)
    if not df.empty and 'exit_date' in df.columns:
        df = df.sort_values('exit_date', ascending=True)
        df['visual_id'] = range(1, len(df) + 1)
        df = df.sort_values('exit_date', ascending=False)
    else:
        df = pd.DataFrame()
    return format_df(df, session.get('config', {}))

# --- CALLBACKS GESTIÓN HISTORIAL ---
@app.callback([Output('history-grid', 'rowData'), Output('hist-msg', 'children')], [Input('btn-del-sel-hist', 'n_clicks'), Input('confirm-del-all', 'submit_n_clicks')], [State('history-grid', 'selectedRows'), State('session-store', 'data')])
def manage_history(n_sel, n_all, selected, session):
    ctx_id = ctx.triggered_id
    if not session: return no_update, ""
    user = session['user']
    if ctx_id == 'btn-del-sel-hist':
        if not selected: return no_update, "Seleccion requerida."
        if db.delete_trade(selected[0]['id']):
            invalidate_perf_caches()
            df = db.get_closed_trades(user)
            df = add_pnl_pct(df)
            # Proteccion tabla vacia dentro del callback
            if not df.empty and 'exit_date' in df.columns:
                df = df.sort_values('exit_date', ascending=True)
                df['visual_id'] = range(1, len(df) + 1)
                df = df.sort_values('exit_date', ascending=False)
            else:
                df = pd.DataFrame()
            return format_df(df, session.get('config', {})), "Registro eliminado."
        return no_update, "Error BD."
    if ctx_id == 'confirm-del-all':
        if db.delete_all_closed_trades(user):
            invalidate_perf_caches()
            return [], "BD limpiada."
        return no_update, "Error BD."
    return no_update, ""

# --- CALLBACKS ANALYTICS ---
@app.callback([Output("fig-equity", "figure"), Output("fig-dd", "figure"), Output("fig-portfolio", "figure"), Output("fig-edge", "figure"), Output("fig-hist", "figure"), Output("kpi-container", "children"), Output("fig-strategy", "figure"), Output("fig-count", "figure"), Output("fig-evo-winrate", "figure"), Output("fig-evo-ratio", "figure")], [Input("initial-balance-input", "value"), Input("strategy-selector", "value"), Input("session-store", "data"), Input("tabs", "value")], prevent_initial_call=False)
def update_analytics(start_bal, selected_metric, session, active_tab=None):
    # Al volver a la pestaña, recalcular en segundo plano; ignorar cambios a otras pestañas
    if ctx.triggered_id == 'tabs' and active_tab != 'tab-analytics':
        return tuple(no_update for _ in range(10))
    if not session:
        return {}, {}, {}, {}, {}, [], {}, {}, {}, {}
    try:
        capital_final = float(start_bal[0] if isinstance(start_bal, list) else start_bal)
    except:
        capital_final = 10000.0
        
    df_closed = db.get_closed_trades(session['user'])
    df_open = db.get_open_trades(session['user'])
    cash_movements_df = db.get_cash_movements(session['user'])
    return get_analytics_figures(df_closed, df_open, capital_final, session.get('config', {}), selected_metric, cash_movements_df)

# --- CALLBACK TOGGLE $/% EN POSICIONES ACTIVAS ---
@app.callback(Output('open-grid', 'columnDefs'), [Input('pnl-mode-toggle', 'value')], [State('session-store', 'data')], prevent_initial_call=True)
def toggle_pnl_mode(mode, session):
    conf = session.get('config', {}) if session else {}
    return build_open_grid_cols(conf, mode or "$")

# --- CALLBACK GRAFICO RIESGO LIVE ---
@app.callback(Output("fig-live-risk", "figure"), [Input("live-chart-mode-selector", "value"), Input("open-grid", "rowData")], [State("session-store", "data")])
def update_live_risk_chart(mode, rows, session):
    if not session or not rows:
        fig = go.Figure()
        fig.update_layout(paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=COLOR_NEUTRAL, font_family="'Inter', 'Segoe UI', sans-serif", xaxis=dict(visible=False), yaxis=dict(visible=False))
        return fig

    df = pd.DataFrame(rows)
    if df.empty: return go.Figure()

    if 'unrealized_pnl' not in df.columns: df['unrealized_pnl'] = 0.0
    if 'open_risk' not in df.columns: df['open_risk'] = 0.0

    for col in ['unrealized_pnl', 'open_risk']:
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    sym = cur_sym(session.get('config', {}))

    def fmt_money(v):
        return f"-{sym}{abs(v):,.0f}" if v < 0 else f"{sym}{v:,.0f}"

    # Look "sombreado": relleno semitransparente + borde sólido del mismo color
    POS_FILL, POS_LINE = "rgba(0, 176, 189, 0.4)", COLOR_POS
    NEG_FILL, NEG_LINE = "rgba(246, 70, 93, 0.4)", COLOR_NEG
    RISK_FILL = "rgba(246, 70, 93, 0.15)"  # riesgo más tenue para no confundir con PnL negativo
    LABEL_FONT = dict(color=TEXT_MAIN, size=11, family="'Inter', 'Segoe UI', sans-serif")

    fig = go.Figure()
    show_legend = False

    if mode == 'TOTAL':
        total_pnl = df['unrealized_pnl'].sum()
        total_risk = df['open_risk'].sum()

        x_cats = ['PNL NO REALIZADO', 'RIESGO ACTUAL']
        fig.add_trace(go.Bar(
            x=x_cats,
            y=[total_pnl, total_risk],
            marker=dict(
                color=[POS_FILL if total_pnl >= 0 else NEG_FILL, RISK_FILL],
                line=dict(color=[POS_LINE if total_pnl >= 0 else NEG_LINE, NEG_LINE], width=1.5),
                cornerradius=6
            ),
            text=[fmt_money(total_pnl), fmt_money(total_risk)],
            textposition='outside', textfont=LABEL_FONT, cliponaxis=False,
            hovertemplate='%{x}<br>' + sym + '%{y:,.2f}<extra></extra>'
        ))
        fig.update_layout(bargap=0.45)

    else:
        df_grouped = df.groupby('symbol')[['unrealized_pnl', 'open_risk']].sum().reset_index()
        x_cats = sorted(df_grouped['symbol'].tolist())
        show_legend = True

        pnl_fill = np.where(df_grouped['unrealized_pnl'] >= 0, POS_FILL, NEG_FILL)
        pnl_line = np.where(df_grouped['unrealized_pnl'] >= 0, POS_LINE, NEG_LINE)
        fig.add_trace(go.Bar(
            name='PnL No Realizado',
            x=df_grouped['symbol'],
            y=df_grouped['unrealized_pnl'],
            marker=dict(color=pnl_fill, line=dict(color=pnl_line, width=1.5), cornerradius=4),
            text=df_grouped['unrealized_pnl'].apply(fmt_money),
            textposition='outside', textfont=LABEL_FONT, cliponaxis=False,
            hovertemplate='%{x} · PnL: ' + sym + '%{y:,.2f}<extra></extra>'
        ))

        fig.add_trace(go.Bar(
            name='Riesgo Actual',
            x=df_grouped['symbol'],
            y=df_grouped['open_risk'],
            marker=dict(color=RISK_FILL, line=dict(color=NEG_LINE, width=1.5), cornerradius=4),
            text=df_grouped['open_risk'].apply(fmt_money),
            textposition='outside', textfont=LABEL_FONT, cliponaxis=False,
            hovertemplate='%{x} · Riesgo: ' + sym + '%{y:,.2f}<extra></extra>'
        ))
        fig.update_layout(barmode='group', bargap=0.3, bargroupgap=0.15)

    fig.update_layout(
        paper_bgcolor=CARD_BG,
        plot_bgcolor=CARD_BG,
        font_color=TEXT_MAIN,
        font_family="'Inter', 'Segoe UI', sans-serif",
        margin=dict(l=20, r=20, t=30, b=20),
        yaxis=dict(showgrid=True, gridcolor="rgba(43, 49, 57, 0.5)", zerolinecolor=BORDER_COLOR,
                   tickprefix=sym, tickformat=",.0f"),
        xaxis=dict(showgrid=False, zerolinecolor=BORDER_COLOR, type='category', categoryarray=x_cats),
        showlegend=show_legend,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1,
                    font=dict(size=11, color=COLOR_NEUTRAL)),
        height=300
    )
    return fig

# --- CALLBACK MONTECARLO ---
@app.callback(
    [
        Output("fig-mc-ret", "figure"), 
        Output("fig-mc-dd", "figure"), 
        Output("fig-mc-curves", "figure"), 
        Output("fig-kelly-curve", "figure"), 
        Output("mc-kpi-container", "children"), 
        Output("mc-results-container", "style")
    ], 
    [Input("btn-run-mc", "n_clicks")], 
    [
        State("mc-n-sim", "value"), 
        State("mc-kelly-frac", "value"), 
        State("session-store", "data")
    ]
)
def run_mc(n_clicks, n_sim, k_frac, session):
    if not session: return {}, {}, {}, {}, [], {'display': 'none'}
    
    sims = int(n_sim) if n_sim else 3000
    frac = float(k_frac) if k_frac else 1.0
    
    df_closed = db.get_closed_trades(session['user'])
    
    fig_ret, fig_dd, fig_curves, fig_kelly, kpis = run_monte_carlo_simulation(df_closed, sims, frac)
    
    return fig_ret, fig_dd, fig_curves, fig_kelly, kpis, {'display': 'block'}

@app.callback([Output('g-msg', 'children'), Output('open-grid', 'rowData'), Output('session-store', 'data', allow_duplicate=True)], [Input('btn-new', 'n_clicks'), Input('upload-data', 'contents')], [State('upload-data', 'filename'), State('nt', 'value'), State('ns', 'value'), State('np', 'value'), State('nq', 'value'), State('nsl', 'value'), State('nd', 'value'), State({'type': 'strat-input', 'index': ALL}, 'value'), State({'type': 'strat-input', 'index': ALL}, 'id'), State('n-notes', 'value'), State('session-store', 'data')], prevent_initial_call=True)
def ops_callback(n_new, list_of_contents, list_of_names, nt, ns, np, nq, nsl, nd, vals, ids, n_notes, s):
    if not s: return no_update, no_update, no_update
    ctx_id = ctx.triggered_id
    
    if ctx_id == 'upload-data' and list_of_contents:
        msg, new_keys = parse_contents(list_of_contents, list_of_names, s['user'])
        invalidate_perf_caches()
        
        # --- AUTO ACTUALIZACION DE CONFIGURACION ---
        if new_keys:
            current_conf = s.get('config', {})
            updated = False
            for k in new_keys:
                if k not in current_conf:
                    current_conf[k] = [] # Agregar la columna a la config
                    updated = True
            
            if updated:
                db.update_user_config(s['user'], current_conf)
                s['config'] = current_conf # Actualizamos la sesión para que el grid lo vea YA
        
        df_open = db.get_open_trades(s['user'])
        if not df_open.empty: df_open = calculate_live_metrics(df_open)
        return msg, format_df(df_open, s.get('config', {})), s
        
    if ctx_id == 'btn-new' and nt:
        tags = {id_dict['index']: val for val, id_dict in zip(vals, ids) if val}
        # AQUI USAMOS LA NUEVA FUNCION DE DB QUE ACEPTA NOTAS
        db.open_new_trade(s['user'], nt.upper(), ns, float(np), int(nq), nd, float(nsl) or 0, float(nsl) or 0, tags, str(n_notes) if n_notes else "")
        invalidate_perf_caches()
        df_open = db.get_open_trades(s['user'])
        if not df_open.empty: df_open = calculate_live_metrics(df_open)
        return "Orden ingresada.", format_df(df_open, s.get('config', {})), no_update
        
    return no_update, no_update, no_update

@app.callback(Output('sl-warning', 'style'), Input('btn-new', 'n_clicks'), State('nsl', 'value'), prevent_initial_call=True)
def toggle_sl_warning(n, nsl):
    if n and not nsl:
        return {"display": "block", "color": COLOR_NEG, "fontFamily": "'Inter', 'Segoe UI', sans-serif", "fontSize": "0.78rem",
                "marginTop": "6px", "padding": "6px 10px", "border": f"1px solid {COLOR_NEG}",
                "borderRadius": "4px", "backgroundColor": "rgba(246, 70, 93, 0.08)"}
    return {"display": "none"}

@app.callback([Output("management-container", "style"), Output("selected-trade-store", "data"), Output("dyn-info", "children"), Output("usl", "value")], Input("open-grid", "selectedRows"))
def toggle(sel):
    return ({'display': 'block'}, sel[0], f"SELECCION: {sel[0]['symbol']}", sel[0]['current_stop_loss']) if sel else ({'display': 'none'}, None, "", "")

@app.callback([Output('g-msg', 'children', allow_duplicate=True), Output('open-grid', 'rowData', allow_duplicate=True), Output("management-container", "style", allow_duplicate=True), Output("open-grid", "selectedRows")], [Input('btn-close', 'n_clicks'), Input('btn-part', 'n_clicks'), Input('btn-sl', 'n_clicks'), Input('btn-del', 'n_clicks'), Input('confirm-del-all-open', 'submit_n_clicks')], [State('selected-trade-store', 'data'), State('cp', 'value'), State('cd', 'value'), State('cr', 'value'), State('pq', 'value'), State('pp', 'value'), State('pd', 'value'), State('usl', 'value'), State('c-notes', 'value'), State('session-store', 'data')], prevent_initial_call=True)
def manage(b1, b2, b3, b4, b_all, trade, cp, cd, cr, pq, pp, p_date, usl, c_notes, s):
    if not s: return no_update, no_update, no_update, no_update
    cid = ctx.triggered_id
    
    if cid == 'confirm-del-all-open':
        df_open = db.get_open_trades(s['user'])
        if not df_open.empty:
            for tid in df_open['id'].tolist():
                db.delete_trade(tid)
        df_open = db.get_open_trades(s['user'])
        if not df_open.empty: df_open = calculate_live_metrics(df_open)
        return "Posiciones eliminadas.", format_df(df_open, s.get('config', {})), {'display': 'none'}, []

    if not trade: return no_update, no_update, no_update, no_update
    tid = trade['id']
    if cid == 'btn-close':
        # AQUI USAMOS LA NUEVA FUNCION DE DB QUE ACEPTA NOTAS DE SALIDA
        db.close_trade_total(tid, cp, cd, cr, str(c_notes) if c_notes else "")
    elif cid == 'btn-part': db.close_partial(tid, pq, pp, p_date or date.today())
    elif cid == 'btn-sl': db.update_stop_loss(tid, usl)
    elif cid == 'btn-del': db.delete_trade(tid)
    invalidate_perf_caches()  # los trades cambiaron: Performance debe recalcular

    df_open = db.get_open_trades(s['user'])
    if not df_open.empty: df_open = calculate_live_metrics(df_open)
    return "Actualizado.", format_df(df_open, s.get('config', {})), {'display': 'none'}, []

# --- CALLBACK APORTES Y RETIROS ---
@app.callback(
    [Output("cash-movements-grid", "rowData"), Output("cm-msg", "children")],
    [Input("btn-add-cm", "n_clicks"), Input("btn-del-cm", "n_clicks")],
    [State("cm-date", "value"), State("cm-amount", "value"),
     State("cm-type", "value"), State("cash-movements-grid", "selectedRows"),
     State("session-store", "data")],
    prevent_initial_call=True
)
def manage_cash_movements(n_add, n_del, cm_date, cm_amount, cm_type, selected, session):
    if not session: return no_update, ""
    user = session['user']

    def _refresh():
        # Invalidar caches de Performance para que el próximo cálculo use los nuevos flujos
        invalidate_perf_caches()
        df = db.get_cash_movements(user)
        return df.to_dict("records") if not df.empty else []

    if ctx.triggered_id == "btn-add-cm":
        if not cm_date or not cm_amount or float(cm_amount) <= 0:
            return no_update, "⚠️ Completar fecha y monto válido."
        if not db.add_cash_movement(user, cm_date, cm_amount, cm_type):
            return no_update, "⚠️ Error al guardar el movimiento."
        return _refresh(), "✓ Movimiento agregado. Elegí un período para recalcular."

    if ctx.triggered_id == "btn-del-cm":
        if not selected:
            return no_update, "⚠️ Seleccioná un movimiento para eliminar."
        if not db.delete_cash_movement(selected[0]['id']):
            return no_update, "⚠️ Error al eliminar el movimiento."
        return _refresh(), "✓ Movimiento eliminado. Elegí un período para recalcular."

    return no_update, ""

# --- CALLBACK EXPORT SERIE DIARIA (diagnóstico de valuación) ---
@app.callback(
    Output("download-daily", "data"),
    Input("btn-export-daily", "n_clicks"),
    State("perf-daily-store", "data"),
    prevent_initial_call=True
)
def export_daily_series(n_clicks, store_data):
    if not store_data:
        return no_update
    df = pd.DataFrame(store_data)
    return dcc.send_data_frame(df.to_csv, "edge_journal_serie_diaria.csv", index=False)

# ══════════════════════════════════════════════════════════
# REEMPLAZÁ tu callback update_performance por este
# (es el mismo pero con prints de diagnóstico al inicio)
# ══════════════════════════════════════════════════════════

BENCHMARK_NAMES = {"SPY": "SPY", "SPY.BA": "SPY CEDEAR", "^MERV": "MERVAL"}

# --- CALLBACK COLLAPSE DE APORTES Y RETIROS ---
@app.callback(
    [Output("collapse-cm", "is_open"), Output("btn-toggle-cm", "children")],
    Input("btn-toggle-cm", "n_clicks"),
    State("collapse-cm", "is_open"),
    prevent_initial_call=True
)
def toggle_cash_movements(n, is_open):
    new_state = not is_open
    return new_state, ("▾ APORTES Y RETIROS" if new_state else "▸ APORTES Y RETIROS")

# --- CALLBACK RESALTADO DE PERÍODO ACTIVO ---
@app.callback(
    [Output("btn-perf-ytd", "style"), Output("btn-perf-yoy", "style"),
     Output("btn-perf-all", "style"), Output("btn-perf-2025", "style")],
    Input("perf-period-store", "data"),
    prevent_initial_call=True
)
def highlight_period_button(period):
    order = ["YTD", "YOY", "ALL", "2025"]
    return [PERF_BTN_ACTIVE_STYLE if period == p else PERF_BTN_STYLE for p in order]

@app.callback(
    [
        Output("fig-perf-cumulative", "figure"),
        Output("fig-perf-drawdown", "figure"),
        Output("perf-kpis-container", "children"),
        Output("perf-status", "children"),
        Output("perf-daily-store", "data"),
        Output("perf-period-store", "data")
    ],
    [
    Input("btn-perf-ytd", "n_clicks"),
    Input("btn-perf-yoy", "n_clicks"),
    Input("btn-perf-all", "n_clicks"),
    Input("btn-perf-2025", "n_clicks"),
    Input("benchmark-selector", "value"),
    Input("perf-autoload", "n_intervals"),
    Input("tabs", "value"),
    ],
    [State("perf-period-store", "data"),
     State("session-store", "data")],
    prevent_initial_call=True
)
def update_performance(n_ytd, n_yoy, n_all, n_2025, benchmark, n_auto, active_tab, stored_period, session):
    """Calcula y muestra el retorno acumulado del portfolio por periodo."""

    # Determinar qué botón se apretó. Si cambió el benchmark, es el disparo
    # automático al montar la pestaña, o el usuario volvió a entrar (tabs),
    # usar el último período (default YTD).
    triggered = ctx.triggered_id
    if triggered == "tabs":
        if active_tab != 'tab-performance':
            return tuple(no_update for _ in range(6))
        period = stored_period or "YTD"
    elif triggered == "btn-perf-ytd":
        period = "YTD"
    elif triggered == "btn-perf-yoy":
        period = "YOY"
    elif triggered == "btn-perf-2025":
        period = "2025"
    elif triggered == "benchmark-selector":
        period = stored_period or "ALL"
    elif triggered == "perf-autoload":
        period = stored_period or "YTD"
    else:
        period = "ALL"

    print("=" * 60)
    print(f"[PERF] 🔥 CALLBACK DISPARADO! Periodo={period} | Benchmark={benchmark}")
    print(f"[PERF] session={session is not None}")
    print("=" * 60)

    empty_fig = go.Figure()
    empty_fig.update_layout(
        paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG,
        font_color=COLOR_NEUTRAL, font_family="'Inter', 'Segoe UI', sans-serif",
        xaxis=dict(visible=False), yaxis=dict(visible=False)
    )
    empty_fig.add_annotation(
        text="Sin datos para este período — registrá tus trades en OPERATIVA",
        showarrow=False, xref="paper", yref="paper", x=0.5, y=0.5,
        font=dict(color=COLOR_NEUTRAL, family="Inter, Segoe UI, sans-serif", size=13)
    )

    if not session:
        return empty_fig, empty_fig, [], "⚠️ Sin sesión", None, period

    user = session['user']

    # Leer capital inicial de la config (mismo que Analytics)
    conf = session.get('config', {})
    initial_balance = conf.get('initial_balance', 10000)
    sym = cur_sym(conf)
    bench_ticker = benchmark if benchmark in BENCHMARK_NAMES else ("SPY.BA" if conf.get('currency') == 'ARS' else "SPY")
    bench_name = BENCHMARK_NAMES[bench_ticker]

    try:
        initial_balance = float(initial_balance)
    except:
        initial_balance = 10000.0

    if initial_balance <= 0:
        return empty_fig, empty_fig, [], "⚠️ Configurá un capital inicial en Analytics", None, period

    # ── CACHE CHECK ──
    cache_key = f"{user}_{initial_balance}_{period}_{bench_ticker}_{sym}"
    now = dt_datetime.now()
    
    if cache_key in _perf_cache:
        elapsed = (now - _perf_cache_time[cache_key]).total_seconds()
        if elapsed < PERF_CACHE_TTL:
            print(f"[PERF] ⚡ CACHE HIT ({elapsed:.0f}s ago)")
            return _perf_cache[cache_key]
        else:
            print(f"[PERF] 🔄 Cache expirado ({elapsed:.0f}s)")
    
    # ── OBTENER TRADES, MOVIMIENTOS Y SERIE DIARIA (con cache por usuario) ──
    # Los cambios de período no reconstruyen la serie: solo la recortan.
    daily_key = (user, initial_balance)
    if daily_key in _daily_cache and (now - _daily_cache_time[daily_key]).total_seconds() < PERF_CACHE_TTL:
        df_closed, df_open, cash_movements_df, daily_full = _daily_cache[daily_key]
        print(f"[PERF] ⚡ Serie diaria desde cache ({len(daily_full)} días)")
    else:
        df_closed = db.get_closed_trades(user)
        df_open = db.get_open_trades(user)
        cash_movements_df = db.get_cash_movements(user)
        print(f"[PERF] Trades cerrados: {len(df_closed)}, abiertos: {len(df_open)}, movimientos: {len(cash_movements_df)}")
        daily_full = None  # se construye más abajo si hay trades

    if df_closed.empty and df_open.empty:
        return empty_fig, empty_fig, [], "⚠️ No hay trades para calcular", None, period
    
    # ── FILTRAR POR PERIODO ──
    today = pd.Timestamp.now().normalize()

    if df_closed.empty:
        df_filtered = pd.DataFrame()
        if period == "YTD":
            period_label = f"YTD ({today.year})"
        elif period == "YOY":
            one_year_ago = today - pd.DateOffset(years=1)
            period_label = f"Último Año ({one_year_ago.strftime('%Y-%m-%d')} → hoy)"
        elif period == "2025":
            period_label = "Año 2025"
        else:
            period_label = "Todo el historial"
    else:
        df_closed['exit_date_dt'] = pd.to_datetime(df_closed['exit_date'])
        if period == "YTD":
            start_of_year = pd.Timestamp(today.year, 1, 1)
            # Incluir trades que estaban abiertos al inicio del año O se abrieron este año
            df_closed['entry_date_dt'] = pd.to_datetime(df_closed['entry_date'])
            mask = (df_closed['exit_date_dt'] >= start_of_year) | \
                   ((df_closed['entry_date_dt'] < start_of_year) & (df_closed['exit_date_dt'] >= start_of_year))
            df_filtered = df_closed[mask].copy()
            period_label = f"YTD ({today.year})"

        elif period == "YOY":
            one_year_ago = today - pd.DateOffset(years=1)
            df_closed['entry_date_dt'] = pd.to_datetime(df_closed['entry_date'])
            mask = (df_closed['exit_date_dt'] >= one_year_ago)
            df_filtered = df_closed[mask].copy()
            period_label = f"Último Año ({one_year_ago.strftime('%Y-%m-%d')} → hoy)"
        elif period == "2025":
            start_2025 = pd.Timestamp(2025, 1, 1)
            end_2025 = pd.Timestamp(2025, 12, 31)
            df_closed['entry_date_dt'] = pd.to_datetime(df_closed['entry_date'])
            mask = (df_closed['exit_date_dt'] >= start_2025) & (df_closed['exit_date_dt'] <= end_2025)
            df_filtered = df_closed[mask].copy()
            period_label = "Año 2025"
        else:  # ALL
            df_filtered = df_closed.copy()
            period_label = "Todo el historial"
    
    # Limpiar columnas auxiliares
    for col in ['exit_date_dt', 'entry_date_dt']:
        if col in df_filtered.columns:
            df_filtered = df_filtered.drop(columns=[col])
    for col in ['exit_date_dt', 'entry_date_dt']:
        if col in df_closed.columns:
            df_closed = df_closed.drop(columns=[col])

    # Filtrar trades abiertos por periodo
    if not df_open.empty:
        df_open['entry_date_dt'] = pd.to_datetime(df_open['entry_date'])
        if period == "2025":
            end_period = pd.Timestamp(2025, 12, 31)
            df_open_filtered = df_open[df_open['entry_date_dt'] <= end_period].copy()
        else:
            # YTD, YOY, ALL: incluir todos los trades actualmente abiertos
            df_open_filtered = df_open.copy()
        df_open_filtered = df_open_filtered.drop(columns=['entry_date_dt'])
    else:
        df_open_filtered = pd.DataFrame()

    if df_filtered.empty and df_open_filtered.empty:
        return empty_fig, empty_fig, [], f"⚠️ No hay trades en el periodo: {period_label}", None, period

    print(f"[PERF] Trades filtrados ({period}): {len(df_filtered)} cerrados, {len(df_open_filtered)} abiertos")
    
    # ── CALCULAR PORTFOLIO ──
    try:
        # Construir SIEMPRE con el historial completo (cerrados + abiertos + movimientos)
        # y recién después recortar al período. Si se filtran los trades antes del build,
        # el PnL realizado previo al período no se acumula al cash y el valor inicial del
        # período queda subestimado (infla el TWR). El valor de arranque del período debe
        # ser el valor real arrastrado de la cuenta (= "Beginning Account Value" del broker).
        if daily_full is None:
            daily_full = build_daily_portfolio(df_closed, initial_balance, df_open, cash_movements_df)
            _daily_cache[daily_key] = (df_closed, df_open, cash_movements_df, daily_full)
            _daily_cache_time[daily_key] = now
        daily_df = daily_full.copy()
        # Recortar al periodo
        if period == "2025":
            daily_df = daily_df[(daily_df['date'] >= '2025-01-01') & (daily_df['date'] <= '2025-12-31')]
        elif period == "YTD":
            daily_df = daily_df[daily_df['date'] >= pd.Timestamp(today.year, 1, 1)]
        elif period == "YOY":
            daily_df = daily_df[daily_df['date'] >= (today - pd.DateOffset(years=1))]
        if daily_df.empty: return empty_fig, empty_fig, [], "⚠️ Portfolio vacío", None, period
        daily_df = daily_df.reset_index(drop=True)
        # Recalcular retorno acumulado desde el inicio del periodo (arranca en 0%)
        # encadenando los retornos diarios TWR (los aportes/retiros no afectan el %)
        period_rets = daily_df['daily_return'].copy()
        period_rets.iloc[0] = 0.0
        daily_df['cumulative_return'] = (1 + period_rets).cumprod() - 1

        # --- BENCHMARK (serie de rango completo cacheada; se recorta por período) ---
        full_start = daily_full['date'].min()
        full_end = daily_full['date'].max()
        bench_key = (bench_ticker, str(full_start.date()), str(full_end.date()))
        if bench_key in _bench_cache and (now - _bench_cache_time[bench_key]).total_seconds() < HIST_CACHE_TTL:
            spy_series = _bench_cache[bench_key]
            print(f"[PERF] ⚡ Benchmark {bench_ticker} desde cache")
        else:
            spy_raw = yf.download(bench_ticker, start=full_start, end=full_end + pd.Timedelta(days=3), progress=False, auto_adjust=True)
            spy_series = None
            if not spy_raw.empty:
                if isinstance(spy_raw.columns, pd.MultiIndex):
                    try: spy_series = spy_raw.xs('Close', level=0, axis=1)[bench_ticker]
                    except: spy_series = spy_raw.iloc[:, 0]
                else:
                    col = 'Close' if 'Close' in spy_raw.columns else spy_raw.columns[0]
                    spy_series = spy_raw[col]
                spy_series.index = pd.to_datetime(spy_series.index).normalize()
            _bench_cache[bench_key] = spy_series
            _bench_cache_time[bench_key] = now

        if spy_series is not None:
            spy_aligned = spy_series.reindex(daily_df['date']).ffill().bfill()
            daily_df['spy_price'] = spy_aligned.values
            print(f"[PERF] Benchmark alineado: {len(spy_aligned)} días, inicio={float(spy_aligned.iloc[0]):.2f}, fin={float(spy_aligned.iloc[-1]):.2f}")
        else:
            daily_df['spy_price'] = np.nan

    except Exception as e:
        import traceback; traceback.print_exc()
        return empty_fig, empty_fig, [], f"⚠️ Error: {str(e)}", None, period
    
    # KPIs Básicos
    total_end = daily_df['total_value'].iloc[-1]
    period_start_value = daily_df['total_value'].iloc[0]
    # Retorno del período: TWR encadenado (neutraliza aportes/retiros)
    total_return = daily_df['cumulative_return'].iloc[-1] * 100

    # Aportes y retiros DEL PERÍODO visualizado (criterio Schwab:
    # "Net Contributions - This Period", no el historial completo)
    p_start = daily_df['date'].iloc[0]
    p_end = daily_df['date'].iloc[-1]
    total_deposits = 0.0
    total_withdrawals = 0.0
    if not cash_movements_df.empty:
        cm_dates = pd.to_datetime(cash_movements_df['movement_date'])
        cm_period = cash_movements_df[(cm_dates >= p_start) & (cm_dates <= p_end)]
        if not cm_period.empty:
            amounts = cm_period['amount'].astype(float)
            is_deposit = cm_period['movement_type'] == 'APORTE'
            total_deposits = amounts[is_deposit].sum()
            total_withdrawals = amounts[~is_deposit].sum()

    # Ganancia neta del período ("Investment Change" de Schwab):
    # valor final - valor inicial - flujos netos del período.
    # Se excluye el día 1 para ser consistente con el TWR re-encadenado (arranca en 0%).
    net_flows_in_period = daily_df['external_flow'].iloc[1:].sum()
    total_pnl = total_end - period_start_value - net_flows_in_period

    # Drawdown sobre la curva TWR (un retiro no cuenta como caída)
    twr_curve = 1 + daily_df['cumulative_return']
    cummax = twr_curve.cummax()
    daily_df['drawdown_pct'] = ((twr_curve - cummax) / cummax) * 100
    max_dd = daily_df['drawdown_pct'].min()
    current_dd = daily_df['drawdown_pct'].iloc[-1]
    
    # --- KPIs AVANZADOS (SPY) ---
    if 'spy_price' in daily_df.columns and not daily_df['spy_price'].isnull().all():
        # SPY normalizado desde la misma fecha de inicio que el portfolio
        spy_start = float(daily_df['spy_price'].iloc[0])
        daily_df['norm_spy'] = ((daily_df['spy_price'] / spy_start) - 1) * 100
        print(f"[PERF] SPY normalizado desde ${spy_start:.2f} (fecha: {daily_df['date'].iloc[0]}) | Retorno SPY periodo: {daily_df['norm_spy'].iloc[-1]:.2f}%")
    else:
        daily_df['norm_spy'] = 0.0

    spy_cummax = daily_df['spy_price'].cummax()
    daily_df['spy_drawdown_pct'] = ((daily_df['spy_price'] - spy_cummax) / spy_cummax) * 100
    max_dd_spy = daily_df['spy_drawdown_pct'].min()
    total_return_spy = daily_df['norm_spy'].iloc[-1]

    # Retornos Diarios (TWR: excluyen el efecto de aportes/retiros)
    port_rets = period_rets
    spy_rets = daily_df['spy_price'].pct_change().fillna(0)
    rfr_daily = 0.04 / 252 # Tasa libre de riesgo (4% anual)
    
    def calc_sharpe(rets):
        if rets.std() == 0: return 0
        return np.sqrt(252) * (rets.mean() - rfr_daily) / rets.std()
        
    def calc_sortino(rets):
        downside = rets[rets < 0]
        if len(downside) < 2: return 0
        down_std = downside.std()
        if down_std == 0: return 0
        return np.sqrt(252) * (rets.mean() - rfr_daily) / down_std

    def calc_calmar(rets, max_drawdown):
        if max_drawdown == 0 or len(rets) < 2: return 0
        ann_return = ((1 + rets).prod() ** (252 / len(rets)) - 1) * 100
        return ann_return / abs(max_drawdown)

    sharpe_port = calc_sharpe(port_rets)
    sharpe_spy = calc_sharpe(spy_rets)
    sortino_port = calc_sortino(port_rets)
    sortino_spy = calc_sortino(spy_rets)
    calmar_port = calc_calmar(port_rets, max_dd)
    calmar_spy = calc_calmar(spy_rets, max_dd_spy)
    
    # Alpha y Beta
    try:
        cov = np.cov(port_rets, spy_rets)
        beta = cov[0, 1] / cov[1, 1] if cov[1, 1] != 0 else 1.0
        # Alpha sobre retornos del período usando las mismas métricas que las tarjetas
        port_total_ret = total_return / 100  # Ya calculado arriba como (total_end / initial_balance - 1) * 100
        spy_total_ret = total_return_spy / 100  # Ya calculado arriba desde norm_spy
        n_days = len(daily_df)
        rfr_period = 0.04 * (n_days / 252)
        alpha = (port_total_ret - rfr_period) - beta * (spy_total_ret - rfr_period)
        alpha *= 100
        print(f"[PERF] Alpha calc: port={port_total_ret*100:.2f}%, spy={spy_total_ret*100:.2f}%, beta={beta:.2f}, rf={rfr_period*100:.2f}%, alpha={alpha:.2f}%")
    except:
        beta, alpha = 1.0, 0.0

    # Time Under Water (TUW)
    is_underwater = daily_df['drawdown_pct'] < -0.0001
    g = (is_underwater != is_underwater.shift()).cumsum()
    underwater_streaks = is_underwater.groupby(g).sum()
    streaks = underwater_streaks[underwater_streaks > 0]
    max_tuw = streaks.max() if not streaks.empty else 0
    avg_tuw = streaks.mean() if not streaks.empty else 0

    # --- RENDER DE TARJETAS KPIs ---
    def make_perf_card(title, main_val_str, sub_text=None, m_color=None):
        v_style = KPI_VAL_STYLE.copy()
        if m_color: v_style['color'] = m_color
        content = [html.P(main_val_str, style=v_style), html.P(title, style=KPI_LBL_STYLE)]
        if sub_text:
            content.append(html.P(sub_text, style={"color": COLOR_NEUTRAL, "fontSize": "0.7rem", "marginTop": "6px", "marginBottom": "0", "fontFamily": "'Inter', 'Segoe UI', sans-serif"}))
        return dbc.Col(html.Div(content, style=KPI_CARD_STYLE), width="auto", className="mb-2 p-1")

    flow_cards = []
    if not cash_movements_df.empty:
        flow_cards = [
            make_perf_card("APORTES (PERÍODO)", f"{sym}{total_deposits:,.0f}", "Depósitos externos", COLOR_POS),
            make_perf_card("RETIROS (PERÍODO)", f"{sym}{total_withdrawals:,.0f}", "Extracciones", COLOR_NEG),
        ]

    kpis_layout = html.Div(dbc.Row([
        make_perf_card("CAPITAL INICIAL", f"{sym}{initial_balance:,.0f}"),
        make_perf_card("VALOR INICIAL", f"{sym}{period_start_value:,.0f}", "Inicio del período"),
        *flow_cards,
        make_perf_card("GANANCIA NETA", f"{sym}{total_pnl:+,.0f}", "Excluye aportes/retiros", COLOR_POS if total_pnl >= 0 else COLOR_NEG),
        make_perf_card("VALOR FINAL", f"{sym}{total_end:,.0f}", "Fin del período"),
        make_perf_card("RETORNO TOTAL (TWR)", f"{total_return:+.2f}%", f"{bench_name}: {total_return_spy:+.2f}%", COLOR_POS if total_return >= 0 else COLOR_NEG),
        make_perf_card("MAX DRAWDOWN", f"{max_dd:.2f}%", f"{bench_name}: {max_dd_spy:.2f}%", COLOR_NEG),
        make_perf_card("SHARPE RATIO", f"{sharpe_port:.2f}", f"{bench_name}: {sharpe_spy:.2f}", TEXT_MAIN),
        make_perf_card("SORTINO RATIO", f"{sortino_port:.2f}", f"{bench_name}: {sortino_spy:.2f}", TEXT_MAIN),
        make_perf_card("CALMAR RATIO", f"{calmar_port:.2f}", f"{bench_name}: {calmar_spy:.2f}", TEXT_MAIN),
        make_perf_card("ALPHA (JENSEN)", f"α {alpha:+.2f}%", "Exceso vs Riesgo", COLOR_SPY),
        make_perf_card("BETA", f"β {beta:.2f}", f"Sensibilidad vs {bench_name}", TEXT_MAIN),
        make_perf_card("TIME UNDER WATER", f"{max_tuw:.0f} Max", f"{avg_tuw:.0f} Promedio (Días)", COLOR_NEG if max_tuw > 0 else TEXT_MAIN),
    ], className="flex-nowrap g-3", style={"padding": "10px 5px"}), style=SCROLL_CONTAINER_STYLE)
    
    # Gráfico cumulative
    fig_cumulative = go.Figure()
    # Agregamos la línea del SPY si existe
    if 'norm_spy' in daily_df.columns:
        fig_cumulative.add_trace(go.Scatter(x=daily_df['date'], y=daily_df['norm_spy'], mode='lines', line=dict(color='#555555', width=1, dash='dash'), name=bench_name))
        
    ret_pct = daily_df['cumulative_return'] * 100
    fig_cumulative.add_trace(go.Scatter(x=daily_df['date'], y=ret_pct, mode='lines', line=dict(color=COLOR_POS, width=2.5), fill='tozeroy', fillcolor='rgba(0, 176, 189, 0.15)', name='Retorno Acumulado', hovertemplate='%{x|%Y-%m-%d}<br>Retorno: %{y:.2f}%<extra></extra>'))
    fig_cumulative.add_hline(y=0, line_dash="dash", line_color=COLOR_NEUTRAL, line_width=1, opacity=0.5)
    fig_cumulative.update_layout(title={'text': f'RETORNO ACUMULADO (%) — {period_label}', 'font': {'size': 14, 'color': TEXT_MAIN, 'family': 'Inter, Segoe UI, sans-serif'}, 'x': 0.5, 'xanchor': 'center'}, paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=TEXT_MAIN, font_family="'Inter', 'Segoe UI', sans-serif", hovermode='x unified', margin=dict(l=60, r=30, t=50, b=10), yaxis=dict(title="Retorno (%)", showgrid=True, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR, ticksuffix='%'), xaxis=dict(showgrid=False), showlegend=False)
    
    # Gráfico drawdown
    fig_drawdown = go.Figure()
    fig_drawdown.add_trace(go.Scatter(x=daily_df['date'], y=daily_df['drawdown_pct'], mode='lines', line=dict(color=COLOR_NEG, width=1.5), fill='tozeroy', fillcolor='rgba(246, 70, 93, 0.2)', name='Drawdown', hovertemplate='%{x|%Y-%m-%d}<br>DD: %{y:.2f}%<extra></extra>'))
    fig_drawdown.update_layout(title={'text': 'DRAWDOWN (%)', 'font': {'size': 14, 'color': TEXT_MAIN, 'family': 'Inter, Segoe UI, sans-serif'}, 'x': 0.5, 'xanchor': 'center'}, paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=TEXT_MAIN, font_family="'Inter', 'Segoe UI', sans-serif", hovermode='x unified', margin=dict(l=60, r=30, t=40, b=30), yaxis=dict(title="DD (%)", showgrid=True, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR, ticksuffix='%'), xaxis=dict(title="Fecha", showgrid=False), showlegend=False)
    
    # Serie diaria para exportar (diagnóstico de valuación vs broker)
    export_cols = ['date', 'total_value', 'cash', 'equity_value', 'external_flow', 'daily_return', 'cumulative_return']
    store_df = daily_df[export_cols].copy()
    store_df['date'] = store_df['date'].dt.strftime('%Y-%m-%d')
    store_data = store_df.to_dict('records')

    open_count = len(df_open_filtered) if not df_open_filtered.empty else 0
    status = f"✓ {period_label} | {len(df_filtered)} cerrados + {open_count} abiertos | {len(daily_df)} días | Retorno: {total_return:+.2f}%"
    print(f"[PERF] ✅ {status}")

    result = (fig_cumulative, fig_drawdown, kpis_layout, status, store_data, period)
    _perf_cache[cache_key] = result; _perf_cache_time[cache_key] = now
    return result

# ═══════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# IMPORTANTE: Esto va DESPUÉS del callback, al final del archivo
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    app.run(debug=True)



