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

app = dash.Dash(__name__, external_stylesheets=[dbc.themes.CYBORG], suppress_callback_exceptions=True)
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
KPI_VAL_STYLE = {"fontSize": "1.25rem", "fontWeight": "bold", "color": TEXT_MAIN, "margin": "0", "fontFamily": "Consolas, monospace"}
KPI_LBL_STYLE = {"fontSize": "0.70rem", "color": COLOR_NEUTRAL, "textTransform": "uppercase", "letterSpacing": "1px", "marginTop": "6px", "fontWeight": "bold", "fontFamily": "Consolas, monospace"}
SCROLL_CONTAINER_STYLE = {"overflowX": "auto", "whiteSpace": "nowrap", "paddingBottom": "15px", "scrollbarWidth": "thin"}

TAB_STYLE = {
    "backgroundColor": BG_COLOR, "color": COLOR_NEUTRAL, "border": "none", 
    "borderBottom": f"1px solid {BORDER_COLOR}", "padding": "15px", "fontWeight": "bold", "cursor": "pointer", "fontFamily": "Consolas, monospace"
}
TAB_SELECTED_STYLE = {
    "backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": "none", 
    "borderBottom": f"3px solid {COLOR_NEUTRAL}", "padding": "15px", "fontWeight": "bold", "cursor": "pointer", "fontFamily": "Consolas, monospace"
}

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
    "--ag-font-family": "Consolas, monospace",
    "--ag-font-size": "13px",
    "--ag-checkbox-checked-color": COLOR_NEUTRAL,
    "--ag-range-selection-border-color": "transparent"
}
INPUT_STYLE = {"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas, monospace", "boxShadow": "none"}
DROPDOWN_STYLE = {"backgroundColor": BG_COLOR, "color": "#000", "border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas, monospace"}

# --- UTILS ---
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
            if param != 'initial_balance':
                df[param] = df['tags'].apply(lambda x: (x or {}).get(param, "-"))
    return df.to_dict("records")

def calculate_live_metrics(df_open):
    if df_open.empty: return df_open
    df_open['current_price'] = df_open['entry_price']; df_open['unrealized_pnl'] = 0.0; df_open['open_risk'] = 0.0
    try:
        tickers = [t for t in df_open['symbol'].unique() if t]
        if tickers:
            data = yf.download(tickers, period="1d", progress=False)['Close']
            def get_p(row):
                s = row['symbol']
                try:
                    if isinstance(data, pd.Series): return float(data.iloc[-1])
                    if isinstance(data, pd.DataFrame) and s in data: return float(data[s].iloc[-1])
                    return row['entry_price']
                except: return row['entry_price']
            df_open['current_price'] = df_open.apply(get_p, axis=1)
            df_open['unrealized_pnl'] = df_open.apply(lambda x: (x['current_price']-x['entry_price'])*x['quantity'] if x['side']=='LONG' else (x['entry_price']-x['current_price'])*x['quantity'], axis=1)
            df_open['open_risk'] = df_open.apply(lambda x: (x['current_stop_loss']-x['entry_price'])*x['quantity'] if x['side']=='LONG' else (x['entry_price']-x['current_stop_loss'])*x['quantity'], axis=1)
            for c in ['current_price','unrealized_pnl','open_risk']: df_open[c] = df_open[c].astype(float).round(2)
    except: pass
    return df_open
# --- NUEVA FUNCIÓN: MARKET PILLS (TICKERS DIARIOS) ---
def get_market_pills(active_tickers):
    default_tickers = ['SPY', 'QQQ']
    # Unimos los default con tus activos (sin repetir)
    all_tickers = default_tickers + [t for t in active_tickers if t not in default_tickers]
    
    pills = []
    try:
        # Descargamos los últimos 5 días para asegurar tener precio de cierre previo y actual
        data = yf.download(all_tickers, period="5d", progress=False, auto_adjust=True)
        if not data.empty:
            closes = data['Close'] if 'Close' in data.columns else data
            
            for t in all_tickers:
                try:
                    if isinstance(closes, pd.DataFrame) and t in closes.columns:
                        s = closes[t].dropna()
                    elif isinstance(closes, pd.Series) and t == all_tickers[0]:
                        s = closes.dropna()
                    else:
                        continue
                        
                    if len(s) >= 2:
                        prev = s.iloc[-2]
                        curr = s.iloc[-1]
                        pct = ((curr / prev) - 1) * 100
                        
                        color = COLOR_POS if pct >= 0 else COLOR_NEG
                        is_bench = t in default_tickers
                        
                        pill = html.Div([
                            html.Span(f"{t} ", style={"color": TEXT_MAIN, "fontWeight": "bold" if is_bench else "normal"}),
                            html.Span(f"{pct:+.2f}%", style={"color": color, "fontWeight": "bold"})
                        ], style={
                            # Resaltamos un poco más el SPY y QQQ
                            "backgroundColor": "#1E222B" if is_bench else CARD_BG,
                            "border": f"1px solid {COLOR_NEUTRAL if is_bench else BORDER_COLOR}",
                            "borderRadius": "4px",
                            "padding": "2px 10px",
                            "fontSize": "0.75rem",
                            "fontFamily": "Consolas, monospace",
                            "whiteSpace": "nowrap"
                        })
                        pills.append(pill)
                except: continue
    except: pass
        
    # Las metemos en un contenedor flexible con scroll invisible
    return html.Div(pills, style={"display": "flex", "gap": "10px", "overflowX": "auto", "scrollbarWidth": "none", "alignItems": "center"})
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
def build_daily_portfolio(df_closed, initial_balance):
    """
    Calcula el valor diario del portfolio basado en trades históricos.
    Descarga precios diarios vía yfinance para posiciones abiertas en cada día.
    """
    if df_closed.empty:
        return pd.DataFrame(columns=['date', 'total_value', 'cumulative_return', 'daily_return'])
    
    # Preparar datos
    df = df_closed.copy()
    df['entry_date'] = pd.to_datetime(df['entry_date']).dt.normalize()
    df['exit_date'] = pd.to_datetime(df['exit_date']).dt.normalize()
    
    # Rango de fechas
    start_date = df['entry_date'].min().date()
    end_date = df['exit_date'].max().date()
    if pd.isna(end_date) or end_date < date.today():
        end_date = date.today()
    
    # Descargar precios históricos
    tickers = list(df['symbol'].unique())
    try:
        print(f"[PERFORMANCE] Descargando precios para {len(tickers)} tickers...")
        prices_raw = yf.download(
            tickers=tickers,
            start=start_date,
            end=end_date + timedelta(days=1),
            auto_adjust=True,
            progress=False
        )
        
        # Formatear precios
        if len(tickers) == 1:
            prices = prices_raw[["Close"]].rename(columns={"Close": tickers[0]})
        else:
            prices = prices_raw["Close"] if "Close" in prices_raw else prices_raw
        
        prices.index = pd.to_datetime(prices.index).normalize()
        
    except Exception as e:
        print(f"[PERFORMANCE] Error descargando precios: {e}")
        return pd.DataFrame() # Retornar vacío si falla para evitar crash
    
    # Calcular cash flows REALIZADOS (solo cuando se cierra la operación)
    # Nota: No restamos el costo al entrar aquí, lo manejaremos dinámicamente en el bucle diario
    realized_pnl_flows = {}
    for _, trade in df.iterrows():
        exit_d = trade['exit_date']
        if pd.notna(exit_d):
            # PnL = (Exit - Entry) * Qty  (Ajustado por lado)
            if trade['side'] == 'LONG':
                pnl = (trade['exit_price'] - trade['entry_price']) * trade['quantity']
            else: # SHORT
                pnl = (trade['entry_price'] - trade['exit_price']) * trade['quantity']
            
            realized_pnl_flows[exit_d] = realized_pnl_flows.get(exit_d, 0) + pnl
    
    # Bucle Diario
    all_dates = prices.index
    daily_values = []
    
    # El "Cash Realizado" empieza en el balance inicial
    current_realized_cash = initial_balance
    
    for day in all_dates:
        # 1. Actualizar Cash con PnL de operaciones cerradas HOY
        current_realized_cash += realized_pnl_flows.get(day, 0)
        
        # 2. Identificar operaciones ABIERTAS este día
        # (Entraron antes o hoy) Y (Aun no salen O salen después de hoy)
        open_trades = df[
            (df['entry_date'] <= day) &
            ((df['exit_date'].isna()) | (df['exit_date'] > day))
        ]
        
        market_value_equity = 0.0
        invested_capital = 0.0
        
        for _, trade in open_trades.iterrows():
            ticker = trade['symbol']
            qty = trade['quantity']
            entry_price = trade['entry_price']
            
            # Capital Comprometido (Cost Basis)
            trade_cost = qty * entry_price
            invested_capital += trade_cost
            
            # Valor de Mercado Actual
            if ticker in prices.columns and pd.notna(prices.loc[day, ticker]):
                current_price = prices.loc[day, ticker]
                
                if trade['side'] == 'LONG':
                    # Valor Long = Precio * Cantidad
                    market_value_equity += current_price * qty
                else: # SHORT
                    # Valor Short = Capital Invertido + Ganancia (o - Pérdida)
                    # PnL Latente = (Entrada - Actual) * Qty
                    pnl_latente = (entry_price - current_price) * qty
                    market_value_equity += (trade_cost + pnl_latente)
            else:
                # Fallback si no hay precio: Valor = Costo (PnL 0)
                market_value_equity += trade_cost

        # 3. Calcular Totales
        # Cash Disponible = Cash Realizado - Capital Invertido en Abiertas
        available_cash = current_realized_cash - invested_capital
        
        # Valor Total Cuenta = Cash Disponible + Valor de Mercado de Inversiones
        total_account_value = available_cash + market_value_equity
        
        daily_values.append({
            'date': day,
            'total_value': total_account_value,
            'cash': available_cash, # Para el gráfico de área verde
            'equity_value': market_value_equity # Para el gráfico de área naranja
        })
    
    # Crear DataFrame resultado
    result = pd.DataFrame(daily_values)
    if not result.empty:
        result['daily_return'] = result['total_value'].pct_change().fillna(0)
        result['cumulative_return'] = (result['total_value'] / initial_balance) - 1
    
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
            font_family="Consolas, monospace", 
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
        make_card(f"{mean_dd:.1f}%", "DD PROMEDIO", COLOR_NEG),
        make_card(f"{p05_dd:.1f}%", "VAR 95%", "red")
    ], className="flex-nowrap g-3", style={"padding": "10px 5px"}), style=SCROLL_CONTAINER_STYLE)

    return fig_ret, fig_dd, fig_eq, fig_kelly, kpis
# --- HELPER: ANALYTICS ---
def get_analytics_figures(df_closed, df_open, start_bal, user_config, selected_metric):
    empty = {"layout": {"xaxis": {"visible": False}, "yaxis": {"visible": False}, "plot_bgcolor": "rgba(0,0,0,0)", "paper_bgcolor": "rgba(0,0,0,0)"}}
    
    def style_fig(fig):
        fig.update_layout(
            paper_bgcolor=CARD_BG, 
            plot_bgcolor=CARD_BG, 
            font_color=COLOR_NEUTRAL,
            font_family="Consolas, monospace",
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
                if k != 'initial_balance':
                    df_closed[k] = df_closed['tags'].apply(lambda x: (x or {}).get(k, "-"))
        
        df_closed['cum'] = df_closed['pnl'].cumsum()
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

        # --- EDGE TEÓRICO ---
        x_vals = np.linspace(0.15, 0.85, 100)
        y_be = (0.00 + 1 - x_vals) / x_vals
        y_good = (0.25 + 1 - x_vals) / x_vals
        y_exc = (0.50 + 1 - x_vals) / x_vals
        
        fig_edge = go.Figure()
        fig_edge.add_trace(go.Scatter(x=x_vals*100, y=y_be, mode='lines', name='Break Even (E=0)', line=dict(color=COLOR_NEG, width=2), fill='tozeroy', fillcolor='rgba(246, 70, 93, 0.2)'))
        fig_edge.add_trace(go.Scatter(x=x_vals*100, y=y_good, mode='lines', name='Bueno (E=0.25)', line=dict(color=COLOR_SPY, width=2), fill='tonexty', fillcolor='rgba(252, 213, 53, 0.2)'))
        fig_edge.add_trace(go.Scatter(x=x_vals*100, y=y_exc, mode='lines', name='Excelente (E=0.5)', line=dict(color=COLOR_POS, width=2), fill='tonexty', fillcolor='rgba(0, 176, 189, 0.2)'))
        fig_edge.add_trace(go.Scatter(x=[win_rate], y=[ratio_money], mode='markers+text', name='Tu Sistema', marker=dict(color=TEXT_MAIN, size=10, line=dict(color=TEXT_MAIN, width=2)), text=['TU SISTEMA'], textposition='top right', textfont=dict(color=TEXT_MAIN, size=12)))
        fig_edge.update_layout(title='EDGE TEORICO', xaxis_title='Win Rate (%)', yaxis_title='Ratio R/B', yaxis=dict(range=[0, max(7, ratio_r + 1)]), xaxis=dict(range=[15, 85]), hovermode='x unified', legend=dict(yanchor="top", y=0.99, xanchor="right", x=0.99, bgcolor="rgba(0,0,0,0)"))
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
            fig_s = px.bar(pnl, x=selected_metric, y='pnl', title=f'PNL POR {str(selected_metric).upper()}', template='plotly_dark')
            fig_s.update_traces(marker_color=np.where(pnl['pnl']>=0, COLOR_POS, COLOR_NEG), marker_line_color=CARD_BG, marker_line_width=1)
            fig_s = style_fig(fig_s)

            fig_c = px.bar(cnt, x=selected_metric, y='count', title=f'TRADES POR {str(selected_metric).upper()}', template='plotly_dark')
            fig_c.update_traces(marker_color=COLOR_NEUTRAL, marker_line_color=CARD_BG, marker_line_width=1)
            fig_c = style_fig(fig_c)
        else: fig_s = fig_c = empty
        
        def make_card(val, label, color=None):
            val_s = KPI_VAL_STYLE.copy(); 
            if color: val_s['color'] = color
            return dbc.Col(html.Div([html.P(val, style=val_s), html.P(label, style=KPI_LBL_STYLE)], style=KPI_CARD_STYLE), width="auto", className="mb-2 p-1")
        
        kpis = html.Div(dbc.Row([
            make_card(f"${total_pnl:,.0f}", "PNL", COLOR_POS if total_pnl>=0 else COLOR_NEG),
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
            make_card(f"${exp_money:.2f}", "E(x)($)"),
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
        liq = (df_closed['eq'].iloc[-1] if not df_closed.empty else start_bal) - df_open['val'].sum()
        if liq < 0: liq = 0
        fig_pie = px.pie(names=pf_d['symbol'].tolist()+['Liquidez'], values=pf_d['v'].tolist()+[liq], title='EXPOSICION', template='plotly_dark', hole=0.6, color_discrete_sequence=[COLOR_NEUTRAL, COLOR_POS, COLOR_NEG, COLOR_SPY])
        fig_pie = style_fig(fig_pie)
    else: fig_pie=empty

    return fig_eq, fig_dd, fig_pie, fig_edge, fig_h, kpis, fig_s, fig_c, fig_evo_winrate, fig_evo_ratio

    if not df_open.empty:
        df_open = calculate_live_metrics(df_open)
        unrl = df_open['unrealized_pnl'].sum(); risk = df_open['open_risk'].sum()
        df_open['val'] = df_open['entry_price'] * df_open['quantity']
        pf_d = df_open.groupby('symbol')['val'].sum().reset_index(name='v')
        liq = (df_closed['eq'].iloc[-1] if not df_closed.empty else start_bal) - df_open['val'].sum()
        if liq < 0: liq = 0
        fig_pie = px.pie(names=pf_d['symbol'].tolist()+['Liquidez'], values=pf_d['v'].tolist()+[liq], title='EXPOSICION', template='plotly_dark', hole=0.6, color_discrete_sequence=[COLOR_NEUTRAL, COLOR_POS, COLOR_NEG, COLOR_SPY])
        fig_pie = style_fig(fig_pie)
    else: fig_pie=empty

    return fig_eq, fig_dd, fig_pie, fig_edge, fig_h, kpis, fig_s, fig_c, fig_evo_winrate, fig_evo_ratio
# --- SHELL Y MODALES ---
global_modals = html.Div([
    dbc.Modal([dbc.ModalHeader("REGISTRO DE USUARIO", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), dbc.ModalBody([dbc.Input(id="reg-u", placeholder="Usuario", className="mb-3", style=INPUT_STYLE), dbc.Input(id="reg-p", placeholder="Contraseña", type="password", className="mb-3", style=INPUT_STYLE), dbc.Input(id="reg-n", placeholder="Nombre Completo", style=INPUT_STYLE), html.Div(id="reg-msg", className="text-danger mt-2")], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-reg", color="dark", className="ms-auto", style={"fontFamily": "Consolas"}), dbc.Button("ACEPTAR", id="do-reg", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "Consolas", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-reg", is_open=False),
    dbc.Modal([dbc.ModalHeader("CONFIGURACION DE ESTRATEGIA", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), dbc.ModalBody([dag.AgGrid(id="conf-grid", columnDefs=[{"field": "Parametro", "editable": True}, {"field": "Opciones", "editable": True, "flex": 1}], rowData=[], dashGridOptions={"rowSelection": "single", "stopEditingWhenCellsLoseFocus": True}, className="ag-theme-alpine-dark", style={"height": "300px", "borderRadius": "4px", **CUSTOM_GRID_STYLE}), dbc.Button("AGREGAR PARAMETRO", id="add-row-btn", color="dark", outline=True, size="sm", className="mt-3 w-100", style={"fontFamily": "Consolas"}), html.Div(id="config-feedback", className="mt-2 text-warning small")], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-config", color="dark", className="ms-auto", style={"fontFamily": "Consolas"}), dbc.Button("GUARDAR", id="save-config", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "Consolas", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-config", is_open=False, size="lg")
])
# --- PANEL DE GESTION DINAMICO (MOVIDO ARRIBA PARA QUE LO LEA EL LAYOUT) ---
def get_management_panel():
    return html.Div(id="management-container", style={'display': 'none'}, children=[
        dbc.Card([
            dbc.CardHeader("PANEL DE GESTION DE RIESGO", style={"backgroundColor": "transparent", "borderBottom": f"1px solid {BORDER_COLOR}", "fontWeight": "bold", "color": TEXT_MAIN, "fontFamily": "Consolas"}), 
            dbc.CardBody([
                html.Div(id="dyn-info", className="mb-3 fw-bold", style={"color": TEXT_MAIN, "fontFamily": "Consolas"}), 
                dbc.Tabs([
                    dbc.Tab(label="CERRAR POSICION", children=[
                        dbc.Row([
                            dbc.Col(dbc.Input(id="cp", placeholder="Precio Salida", type="number", style=INPUT_STYLE), width=4), 
                            dbc.Col(dbc.Input(id="cd", type="date", value=date.today(), style=INPUT_STYLE), width=4), 
                            dbc.Col(dbc.Select(id="cr", options=[{"label":x,"value":x} for x in ["WIN","LOSS","BE"]], value="WIN", style=INPUT_STYLE), width=4)
                        ], className="my-3"), 
                        dbc.Textarea(id="c-notes", placeholder="Notas de salida / Lecciones aprendidas...", style={"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas", "marginBottom": "15px", "height": "80px"}),
                        dbc.Button("LIQUIDAR TOTALIDAD", id="btn-close", color="danger", className="w-100 fw-bold", style={"backgroundColor": COLOR_NEG, "border": "none", "fontFamily": "Consolas"})
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE), 
                    
                    dbc.Tab(label="TOMA PARCIAL", children=[
                        dbc.Row([
                            dbc.Col(dbc.Input(id="pq", placeholder="Cantidad", type="number", style=INPUT_STYLE), width=6), 
                            dbc.Col(dbc.Input(id="pp", placeholder="Precio Salida", type="number", style=INPUT_STYLE), width=6)
                        ], className="my-3"), 
                        dbc.Button("EJECUTAR PARCIAL", id="btn-part", color="light", className="w-100 fw-bold text-dark", style={"border": "none", "fontFamily": "Consolas"})
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE), 
                    
                    dbc.Tab(label="AJUSTAR SL", children=[
                        dbc.InputGroup([
                            dbc.InputGroupText("NUEVO SL", style={"backgroundColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "border": "none", "fontFamily": "Consolas"}), 
                            dbc.Input(id="usl", type="number", style=INPUT_STYLE), 
                            dbc.Button("ACTUALIZAR", id="btn-sl", color="light", className="text-dark", style={"fontFamily": "Consolas"})
                        ], className="my-3"), 
                        dbc.Button("ELIMINAR REGISTRO INDIVIDUAL (DB)", id="btn-del", color="dark", size="sm", className="w-100 mt-2 text-danger border-danger", style={"fontFamily": "Consolas"})
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE),
                    dbc.Tab(label="BORRAR TODO", children=[
                        html.Div([
                            dcc.ConfirmDialogProvider(
                                children=dbc.Button("ELIMINAR TODAS LAS POSICIONES (RESET)", id="btn-del-all-open", color="danger", className="w-100 fw-bold", style={"backgroundColor": "rgba(246, 70, 93, 0.2)", "color": COLOR_NEG, "border": f"1px solid {COLOR_NEG}", "fontFamily": "Consolas"}),
                                id="confirm-del-all-open",
                                message="¿ESTÁS SEGURO? Se eliminarán TODOS los trades activos sin guardarlos en el historial."
                            )
                        ], className="my-3")
                    ], style=TAB_STYLE, tab_style=TAB_STYLE, active_tab_style=TAB_SELECTED_STYLE)
                ])
            ])
        ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 10px 30px rgba(0,0,0,0.5)"})
    ], className="mt-4")

# --- SHELL Y MODALES ---
global_modals = html.Div([
    dbc.Modal([dbc.ModalHeader("REGISTRO DE USUARIO", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), dbc.ModalBody([dbc.Input(id="reg-u", placeholder="Usuario", className="mb-3", style=INPUT_STYLE), dbc.Input(id="reg-p", placeholder="Contraseña", type="password", className="mb-3", style=INPUT_STYLE), dbc.Input(id="reg-n", placeholder="Nombre Completo", style=INPUT_STYLE), html.Div(id="reg-msg", className="text-danger mt-2")], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-reg", color="dark", className="ms-auto", style={"fontFamily": "Consolas"}), dbc.Button("ACEPTAR", id="do-reg", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "Consolas", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-reg", is_open=False),
    dbc.Modal([dbc.ModalHeader("CONFIGURACION DE ESTRATEGIA", style={"backgroundColor": CARD_BG, "color": TEXT_MAIN, "borderBottom": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), dbc.ModalBody([dag.AgGrid(id="conf-grid", columnDefs=[{"field": "Parametro", "editable": True}, {"field": "Opciones", "editable": True, "flex": 1}], rowData=[], dashGridOptions={"rowSelection": "single", "stopEditingWhenCellsLoseFocus": True}, className="ag-theme-alpine-dark", style={"height": "300px", "borderRadius": "4px", **CUSTOM_GRID_STYLE}), dbc.Button("AGREGAR PARAMETRO", id="add-row-btn", color="dark", outline=True, size="sm", className="mt-3 w-100", style={"fontFamily": "Consolas"}), html.Div(id="config-feedback", className="mt-2 text-warning small")], style={"backgroundColor": CARD_BG}), dbc.ModalFooter([dbc.Button("CANCELAR", id="close-config", color="dark", className="ms-auto", style={"fontFamily": "Consolas"}), dbc.Button("GUARDAR", id="save-config", color="success", style={"backgroundColor": COLOR_POS, "border": "none", "fontFamily": "Consolas", "color": "#000"})], style={"backgroundColor": CARD_BG, "borderTop": f"1px solid {BORDER_COLOR}"})], id="modal-config", is_open=False, size="lg")
])

def layout_login():
    return dbc.Row([dbc.Col(dbc.Card([dbc.CardBody([html.H2("Edge Journal", className="text-center mb-4 fw-bold", style={"color": TEXT_MAIN, "letterSpacing": "2px"}), dbc.Input(id="user-in", placeholder="Usuario", className="mb-3 p-3", style=INPUT_STYLE), dbc.Input(id="pass-in", placeholder="Password", type="password", className="mb-4 p-3", style=INPUT_STYLE), dbc.Button("INICIAR SESION", id="login-btn", color="success", className="w-100 mb-3 p-3 fw-bold", style={"backgroundColor": COLOR_POS, "color": "#000", "border": "none", "fontFamily": "Consolas"}), dbc.Button("Crear Cuenta", id="open-reg", color="link", className="w-100 text-decoration-none", style={"color": COLOR_NEUTRAL, "fontFamily": "Consolas"})])], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 20px 40px rgba(0,0,0,0.4)"}), width={"size": 4, "offset": 4}, className="mt-5 pt-5")])

def layout_dashboard(username):
    return html.Div([
        # --- CABECERA SUPERIOR (NUEVO ALINEAMIENTO) ---
        dbc.Row([
            dbc.Col(html.Div(f"USER: {username}", style={"color": COLOR_NEUTRAL, "fontSize": "14px", "fontWeight": "bold"}), width=2), 
            
            # --- AQUÍ VAN A VIVIR LAS PÍLDORAS AHORA ---
            dbc.Col(html.Div(id="top-market-pills", style={"minHeight": "32px"}), width=7),
            
            dbc.Col(html.Div(id="g-msg", className="text-end fw-bold", style={"color": COLOR_NEUTRAL}), width=3)
        ], className="mb-4 mt-2 align-items-center"), 
        # ----------------------------------------------
        
        dcc.Tabs(id="tabs", value='tab-active', children=[
            dcc.Tab(label='OPERATIVA', value='tab-active', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE), 
            dcc.Tab(label='HISTORIAL', value='tab-history', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE), 
            dcc.Tab(label='ANALYTICS', value='tab-analytics', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='SIMULADOR DE RIESGO', value='tab-montecarlo', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='PERFORMANCE', value='tab-performance', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE),
            dcc.Tab(label='INFORMACIÓN Y USO', value='tab-info', style=TAB_STYLE, selected_style=TAB_SELECTED_STYLE)
        ]), 
        html.Div(id='tab-content', className="pt-4"), html.Div(id="hidden-wrapper")
    ])

# --- WRAPPER GENERAL PREMIUM ---
app.layout = html.Div([
    dcc.Store(id='session-store', storage_type='session'),
    dcc.Store(id='selected-trade-store'),
    dcc.Location(id='url', refresh=False),
    global_modals,
    dbc.Container([
        dbc.Row([
            # CAMBIO AQUI: Quitamos 'fw-bold' y agregamos 'fontWeight': 'normal'
            dbc.Col(html.H2("EDGE JOURNAL", className="my-4", style={"color": TEXT_MAIN, "fontWeight": "normal", "letterSpacing": "1px", "textShadow": f"0 0 20px {COLOR_POS}33"}), width=8), 
            dbc.Col([
                dbc.Button("CONFIG. ESTRATEGIA", id="open-config-btn", color="dark", className="me-3 fw-bold", style={"border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), 
                dbc.Button("SALIR", id="logout-btn", color="dark", outline=True, className="fw-bold", style={"fontFamily": "Consolas", "color": COLOR_NEUTRAL, "borderColor": BORDER_COLOR})
            ], width=4, className="mt-4 text-end")
        ]), 
        html.Div(id='page-content')
    ], fluid=True, style={"maxWidth": "1600px"})
], style={"backgroundColor": BG_COLOR, "minHeight": "100vh", "fontFamily": "Consolas, monospace", "color": TEXT_MAIN, "paddingBottom": "50px"})

app.validation_layout = html.Div([app.layout, layout_login(), layout_dashboard("User"), global_modals, get_management_panel()])

# --- CALLBACKS CORE ---
@app.callback(Output('page-content', 'children'), [Input('session-store', 'data')])
def render_page(s): return layout_dashboard(s['user']) if s and 'user' in s else layout_login()

@app.callback(Output('session-store', 'data'), Input('login-btn', 'n_clicks'), State('user-in', 'value'), prevent_initial_call=True)
def handle_login(n_clicks, u):
    if n_clicks and u:
        user = db.get_user(u)
        if user: return {'user': u, 'config': user.get('config', {})}
    return no_update

@app.callback(Output('session-store', 'data', allow_duplicate=True), Input('logout-btn', 'n_clicks'), prevent_initial_call=True)
def handle_logout(n_clicks):
    if n_clicks: return {}
    return no_update

@app.callback([Output("modal-reg", "is_open"), Output("reg-msg", "children")], Input("open-reg", "n_clicks"), prevent_initial_call=True)
def open_reg_modal(n_open):
    if n_open: return True, ""
    return no_update, no_update

@app.callback([Output("modal-reg", "is_open", allow_duplicate=True), Output("reg-msg", "children", allow_duplicate=True)], [Input("close-reg", "n_clicks"), Input("do-reg", "n_clicks")], [State("reg-u", "value"), State("reg-p", "value"), State("reg-n", "value")], prevent_initial_call=True)
def process_reg(n_close, n_do, user, password, name):
    if ctx.triggered_id == "close-reg": return False, ""
    if ctx.triggered_id == "do-reg":
        if not user or not password: return True, "Faltan datos"
        success, msg = db.register_user(user, password, name or "")
        return (False, "") if success else (True, msg)
    return no_update, no_update

@app.callback([Output("modal-config", "is_open"), Output("conf-grid", "rowData"), Output("session-store", "data", allow_duplicate=True), Output("config-feedback", "children")], [Input("open-config-btn", "n_clicks"), Input("close-config", "n_clicks"), Input("save-config", "n_clicks"), Input("add-row-btn", "n_clicks")], [State("modal-config", "is_open"), State("conf-grid", "rowData"), State("session-store", "data")], prevent_initial_call=True)
def config_modal(n1, n2, n3, n4, is_open, rows, session):
    if not session: return False, [], no_update, ""
    if ctx.triggered_id == "open-config-btn":
        data = [{"Parametro": k, "Opciones": ", ".join(v) if isinstance(v, list) else str(v)} for k, v in session.get('config', {}).items() if k != 'initial_balance']
        return True, data, no_update, ""
    if ctx.triggered_id == "add-row-btn": 
        return True, (rows or []) + [{"Parametro": "", "Opciones": ""}], no_update, ""
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
            
        db.update_user_config(session['user'], new_conf)
        session['config'] = new_conf
        return False, no_update, session, ""
    return False, no_update, no_update, ""

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

@app.callback(Output('tab-content', 'children'), [Input('tabs', 'value'), Input('session-store', 'data')])
def render_tab(tab, session):
    if not session: return html.Div()
    user, conf = session['user'], session.get('config', {})
    
    if tab == 'tab-active':
        df = db.get_open_trades(user)
        
        # --- AGREGAMOS ESTA VARIABLE ---
        tickers_list = [] 
        
        if not df.empty: 
            df = calculate_live_metrics(df)
            # --- Y OBTENEMOS LOS TICKERS ---
            tickers_list = [str(t).upper() for t in df['symbol'].unique() if pd.notna(t)]
            
        dyn_inputs = []
        if isinstance(conf, dict):
            dyn_inputs.append(html.Hr(style={"borderColor": BORDER_COLOR}))
            row = []
            for p, opts in conf.items():
                if p != 'initial_balance' and isinstance(opts, list): 
                    row.append(dbc.Col([dbc.Label(p, className="small fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Select(id={'type': 'strat-input', 'index': p}, options=[{"label": str(o), "value": str(o)} for o in opts], style=INPUT_STYLE)], width=3, className="mb-3"))
            for i in range(0, len(row), 4): dyn_inputs.append(dbc.Row(row[i:i+4]))
        
        dyn_cols = [{"field": k, "headerName": k, "width": 100} for k in conf.keys() if k != 'initial_balance'] if isinstance(conf, dict) else []
        cols = [{"field": "id", "checkboxSelection": True, "width": 50}, {"field": "symbol", "width": 90}, {"field": "side", "width": 80, "cellStyle": {"styleConditions": [{"condition": "params.value=='LONG'", "style": {"color": COLOR_POS}}, {"condition": "params.value=='SHORT'", "style": {"color": COLOR_NEG}}]}}, {"field": "quantity", "headerName": "Qty", "width": 70}] + dyn_cols + [{"field": "entry_price", "headerName": "In", "width": 90}, {"field": "current_price", "headerName": "Live", "width": 90, "cellStyle": {'fontWeight': 'bold'}}, {"field": "unrealized_pnl", "headerName": "PnL ($)", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}}, {"field": "open_risk", "headerName": "Riesgo", "width": 90, "cellStyle": {'color': COLOR_NEG}}, {"field": "current_stop_loss", "headerName": "SL Act", "width": 90, "editable": True, "cellStyle": {'color': TEXT_MAIN, 'fontWeight': 'bold', 'backgroundColor': '#2B3139'}}]
        
        return dbc.Row([
            dbc.Col([
                dbc.Card([
                    dbc.CardHeader("NUEVA OPERACION", style={"backgroundColor": "transparent", "borderBottom": f"1px solid {BORDER_COLOR}", "fontWeight": "bold", "color": TEXT_MAIN}), 
                    dbc.CardBody([
                        dbc.Row([dbc.Col(dbc.Input(id="nt", placeholder="Ticker", style=INPUT_STYLE), width=3), dbc.Col(dbc.Select(id="ns", options=[{"label":"LONG","value":"LONG"},{"label":"SHORT","value":"SHORT"}], value="LONG", style=INPUT_STYLE), width=3), dbc.Col(dbc.Input(id="nq", placeholder="Qty", type="number", style=INPUT_STYLE), width=3), dbc.Col(dbc.Input(id="nd", type="date", value=date.today(), style=INPUT_STYLE), width=3)], className="mb-3"), 
                        dbc.Row([dbc.Col(dbc.Input(id="np", placeholder="Precio In", type="number", style=INPUT_STYLE), width=6), dbc.Col(dbc.Input(id="nsl", placeholder="SL Inicial", type="number", style=INPUT_STYLE), width=6)]), 
                        html.Div(dyn_inputs), html.Hr(style={"borderColor": BORDER_COLOR}), 
                        
                        # --- NOTAS DE ENTRADA ---
                        dbc.Textarea(id="n-notes", placeholder="Notas de entrada...", style={"backgroundColor": BG_COLOR, "color": TEXT_MAIN, "border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas", "marginBottom": "15px", "height": "80px"}),
                        
                        dbc.Button("EJECUTAR ORDEN", id="btn-new", color="light", className="w-100 mb-3 fw-bold text-dark", style={"border": "none", "padding": "12px", "fontFamily": "Consolas"}), 
                        dcc.Upload(id='upload-data', children=dbc.Button("IMPORTAR EXCEL", color="dark", outline=True, size="sm", className="w-100", style={"borderColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "fontFamily": "Consolas"}), multiple=False)
                    ])
                ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "borderRadius": "4px", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"}),
                get_management_panel()
            ], width=5), 
            dbc.Col([
                # Devolvemos el título simple a la tabla
                html.H5("POSICIONES ACTIVAS", className="fw-bold mb-3", style={"color": TEXT_MAIN}), 
                
                html.Div(dag.AgGrid(id="open-grid", rowData=format_df(df, conf), columnDefs=cols, dashGridOptions={"rowSelection": "single"}, className="ag-theme-alpine-dark", style={"height": "350px", "width": "100%", **CUSTOM_GRID_STYLE}), style={"borderRadius": "4px", "overflow": "hidden", "border": "none", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"}),
                html.Hr(style={"borderColor": BORDER_COLOR, "margin": "30px 0"}),
                dbc.Row([
                    dbc.Col(html.H5("EXPOSICION LIVE", className="fw-bold mb-3", style={"color": TEXT_MAIN}), width=8),
                    dbc.Col(dcc.Dropdown(id='live-chart-mode-selector', options=[{'label': 'TOTAL PORTFOLIO', 'value': 'TOTAL'}, {'label': 'POR ACTIVO', 'value': 'SYMBOL'}], value='TOTAL', clearable=False, style=DROPDOWN_STYLE), width=4)
                ]),
                html.Div(dcc.Graph(id="fig-live-risk", style={'height': '300px'}), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"})
            ], width=7)
        ])

    elif tab == 'tab-history':
        df = db.get_closed_trades(user)
        
        if not df.empty and 'exit_date' in df.columns:
            df = df.sort_values('exit_date', ascending=True)
            df['visual_id'] = range(1, len(df) + 1)
            df = df.sort_values('exit_date', ascending=False)
        else:
            df['visual_id'] = [] 
            
        dyn_cols = [{"field": k, "headerName": k, "width": 100} for k in conf.keys() if k != 'initial_balance'] if isinstance(conf, dict) else []
        cols = [{"field": "id", "checkboxSelection": True, "width": 50}, {"field": "visual_id", "headerName": "#", "width": 60, "sortable": True}, {"field": "entry_date", "width": 100}, {"field": "symbol", "width": 90}, {"field": "side", "width": 80, "cellStyle": {"styleConditions": [{"condition": "params.value=='LONG'", "style": {"color": COLOR_POS}}, {"condition": "params.value=='SHORT'", "style": {"color": COLOR_NEG}}]}}, {"field": "quantity", "headerName": "Qty", "width": 80}, {"field": "result_type", "width": 70}, {"field": "entry_price", "width": 90}, {"field": "exit_price", "width": 90}, {"field": "initial_stop_loss", "width": 80}, {"field": "current_stop_loss", "width": 80}] + dyn_cols + [{"field": "rr", "headerName": "R", "width": 80}, {"field": "pnl", "headerName": "PnL", "width": 90, "cellStyle": {"styleConditions": [{"condition": "params.value >= 0", "style": {"color": COLOR_POS}}, {"condition": "params.value < 0", "style": {"color": COLOR_NEG}}]}}, 
                # --- NOTAS ---
                {"field": "entry_notes", "headerName": "Notas Entrada", "width": 200, "editable": True, "cellEditor": "agLargeTextCellEditor"},
                {"field": "exit_notes", "headerName": "Notas Salida", "width": 200, "editable": True, "cellEditor": "agLargeTextCellEditor"},
                {"field": "exit_date", "width": 100}]
        
        return html.Div([
            dbc.Row([
                dbc.Col(dbc.Button("BORRAR SELECCION", id="btn-del-sel-hist", color="dark", className="me-2 fw-bold", style={"border": f"1px solid {BORDER_COLOR}", "fontFamily": "Consolas"}), width="auto"), 
                
                # --- BOTON PELIGROSO ---
                dbc.Col(
                    dbc.Accordion([
                        dbc.AccordionItem([
                            dcc.ConfirmDialogProvider(
                                children=dbc.Button("BORRAR BASE DE DATOS", id="btn-del-all-hist", color="danger", className="fw-bold w-100", style={"backgroundColor": "red", "color": "white", "fontFamily": "Consolas"}),
                                id="confirm-del-all", message="⚠️ ¡CUIDADO! ¿Eliminar todo el historial? Esta acción NO se puede deshacer."
                            )
                        ], title="⚠️ BORRAR BD COMPLETA")
                    ], start_collapsed=True, flush=True, style={"minWidth": "300px"}), width="auto"
                ),
                
                dbc.Col(html.Div(id="hist-msg", className="small mt-2 fw-bold", style={"color": TEXT_MAIN}), width="auto")
            ], className="mb-4 align-items-center"), 
            html.Div(dag.AgGrid(id="history-grid", rowData=format_df(df, conf), columnDefs=cols, dashGridOptions={"rowSelection": "single"}, className="ag-theme-alpine-dark", style={"height": "650px", "width": "100%", **CUSTOM_GRID_STYLE}), style={"borderRadius": "4px", "overflow": "hidden", "border": "none", "boxShadow": "0 10px 30px rgba(0,0,0,0.3)"})
        ])

    elif tab == 'tab-analytics':
        strategy_options = [{"label": k, "value": k} for k in conf.keys() if k != 'initial_balance'] if isinstance(conf, dict) else []
        default_val = strategy_options[0]['value'] if strategy_options else None
        saved_bal = conf.get('initial_balance', 10000)
        
        return html.Div([
            dbc.Row([
                dbc.Col(html.H3("METRICAS DE SISTEMA", className="fw-bold", style={"color": TEXT_MAIN}), width=9), 
                dbc.Col(dbc.InputGroup([dbc.InputGroupText("CAPITAL INICIAL", style={"backgroundColor": BORDER_COLOR, "color": COLOR_NEUTRAL, "border": "none", "fontWeight": "bold", "fontFamily": "Consolas", "fontSize": "12px"}), dbc.Input(id="initial-balance-input", type="number", value=saved_bal, debounce=True, style=INPUT_STYLE)]), width=3)
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
                dbc.Row([dbc.Col([html.Label("ATRIBUCION POR PARAMETRO:", className="fw-bold mb-2", style={"color": COLOR_NEUTRAL, "letterSpacing": "1px", "fontSize": "0.8rem", "fontFamily": "Consolas"}), dcc.Dropdown(id='strategy-selector', options=strategy_options, value=default_val, clearable=False, style=DROPDOWN_STYLE)], width=4, className="mb-4")]),
                dbc.Row([dbc.Col(html.Div(dcc.Graph(id="fig-strategy"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6), dbc.Col(html.Div(dcc.Graph(id="fig-count"), style={"borderRadius": "4px", "overflow": "hidden", "border": f"1px solid {BORDER_COLOR}", "boxShadow": "0 4px 12px rgba(0,0,0,0.15)"}), width=6)])
            ]))
        ])

    elif tab == 'tab-montecarlo':
        return html.Div([
            dbc.Row([
                dbc.Col([html.H3("MONTECARLO ENGINE", className="fw-bold text-light"), html.P("Generador de escenarios estocasticos basado en distr. de R.", className="text-muted")], width=6),
                dbc.Col([dbc.Label("N° Iteraciones", className="fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Input(id="mc-n-sim", type="number", value=3000, min=100, max=10000, style=INPUT_STYLE)], width=3),
                dbc.Col([dbc.Label("Kelly Fraction (f*)", className="fw-bold", style={"color": COLOR_NEUTRAL}), dbc.Input(id="mc-kelly-frac", type="number", value=1.0, min=0.1, max=2.0, step=0.01, style=INPUT_STYLE)], width=3),
            ], className="mb-4 align-items-center"),
            dbc.Button("INICIAR SIMULACION", id="btn-run-mc", color="light", className="w-100 mb-5 fw-bold p-3 text-dark", style={"border": "none", "borderRadius": "4px", "fontSize": "1.1rem", "fontFamily": "Consolas"}),
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
        # Leemos el capital para mostrarlo
        current_cap = conf.get('initial_balance', 10000)
        
        return dbc.Container([
            # Controles (Sin Título, solo el botón y el info de capital)
            dbc.Row([
                dbc.Col([
                    html.P(f"Base Capital: ${current_cap:,.0f}", 
                           style={"color": COLOR_NEUTRAL, "fontSize": "0.9rem", "marginTop": "20px"})
                ], width=8),
                
                dbc.Col([
                    dbc.Button(
                        "🔄 RECALCULAR", 
                        id="btn-calc-performance", 
                        color="success", outline=True, size="sm",
                        className="mt-3 float-end",
                        style={"fontFamily": "Consolas", "fontWeight": "bold"}
                    )
                ], width=4)
            ]),
            
            html.Hr(style={"borderColor": BORDER_COLOR}),

            # Selector de Periodo
            dbc.Row([
                dbc.Col([
                    dbc.Label("SELECCIONAR PERIODO:", style={"color": COLOR_NEUTRAL, "fontSize": "0.75rem", "fontWeight": "bold"}),
                    dbc.RadioItems(
                        id="perf-period-selector",
                        options=[
                            {"label": "HISTÓRICO COMPLETO", "value": "ALL"},
                            {"label": "YEAR TO DATE (YTD)", "value": "YTD"},
                            {"label": "AÑO ANTERIOR", "value": "LAST_YEAR"},
                            {"label": "ÚLTIMOS 3 MESES", "value": "3M"},
                        ],
                        value="ALL",
                        inline=True,
                        className="btn-group-period",
                        inputClassName="btn-check",
                        labelClassName="btn btn-outline-secondary btn-sm",
                        labelStyle={"marginRight": "10px", "fontFamily": "Consolas", "fontSize": "0.8rem"}
                    )
                ], width=12, className="text-center mb-4")
            ]),

            dcc.Loading(
                id="loading-performance", type="circle", color=COLOR_POS,
                children=html.Div([
                    html.Div(id="perf-kpis-container", style={"marginBottom": "25px"}),
                    html.Div(id="perf-status", style={"marginBottom": "15px"}),
        
                    # Gráfico 1: Retorno (Grande)
                    dbc.Row([
                        dbc.Col(dcc.Graph(id="fig-perf-cumulative", config={'displayModeBar': False}, style={"height": "450px"}), width=12)
                    ]),
                    
                    # Gráfico 2: Drawdown (Chiquito)
                    dbc.Row([
                        dbc.Col(dcc.Graph(id="fig-perf-drawdown", config={'displayModeBar': False}, style={"height": "250px"}), width=12)
                    ], style={"marginTop": "20px"})
                ])
            )
            
        ], fluid=True, style={"backgroundColor": BG_COLOR, "minHeight": "100vh", "padding": "20px"})
    
    elif tab == 'tab-info':
        return html.Div([
            dbc.Row([
                dbc.Col([
                    html.H3("MANUAL DE USUARIO", className="mb-4", style={"color": TEXT_MAIN, "letterSpacing": "1px"}),
                    
                    # --- SECCION 1: OBJETIVOS ---
                    dbc.Card([
                        dbc.CardHeader("🎯 OBJETIVO DEL SITIO", style={"fontWeight": "bold", "color": TEXT_MAIN}),
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
                        dbc.CardHeader("📂 IMPORTACIÓN DE EXCEL (FORMATO REQUERIDO)", style={"fontWeight": "bold", "color": COLOR_POS}),
                        dbc.CardBody([
                            html.P("Si se desea importar un historial de operaciones, tu archivo (.csv o .xlsx) debe contener las siguientes columnas (no importa el orden):", className="card-text"),
                            
                            dbc.Table([
                                html.Thead(html.Tr([html.Th("Columna"), html.Th("Descripción"), html.Th("Ejemplo")])),
                                html.Tbody([
                                    html.Tr([html.Td("TICKER / SYMBOL"), html.Td("Símbolo del activo operado"), html.Td("AAPL, EURUSD, BTC")]),
                                    html.Tr([html.Td("SIDE"), html.Td("Dirección de la operación"), html.Td("LONG / SHORT")]),
                                    html.Tr([html.Td("QTY / QUANTITY"), html.Td("Cantidad de contratos/acciones"), html.Td("10, 100")]),
                                    html.Tr([html.Td("PRECIO IN / ENTRY"), html.Td("Precio de entrada promedio"), html.Td("150.50")]),
                                    html.Tr([html.Td("PRECIO OUT / EXIT"), html.Td("Precio de salida (Opcional, si está cerrado)"), html.Td("155.00")]),
                                    html.Tr([html.Td("SL / STOP LOSS"), html.Td("Stop Loss inicial (Vital para cálculo de R)"), html.Td("148.00")]),
                                    html.Tr([html.Td("FECHA / DATE"), html.Td("Fecha de entrada (YYYY-MM-DD)"), html.Td("2023-10-25")]),
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
                        dbc.CardHeader("🧭 GUÍA DE NAVEGACIÓN", style={"fontWeight": "bold", "color": TEXT_MAIN}),
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
                                    html.P("Evaluación avanzada del rendimiento del portafolio frente al mercado (Benchmark):"),
                                    html.Ul([
                                        html.Li("Visualizar el Retorno Acumulado y la evolución del Drawdown en distintos periodos (YTD, Año Anterior, Histórico Completo)."),
                                        html.Li("Comparar métricas de desempeño y caídas directamente contra el S&P 500 (SPY)."),
                                        html.Li("Medir la calidad del retorno con métricas de riesgo ajustadas como Sharpe, Sortino, Alpha de Jensen y Beta.")
                                    ])
                                ], title="5. PERFORMANCE")

                            ], start_collapsed=True, flush=True)
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}", "marginBottom": "20px"}),

                    # --- SECCION 4: GLOSARIO ---
                    dbc.Card([
                        dbc.CardHeader("📚 GLOSARIO Y FÓRMULAS", style={"fontWeight": "bold", "color": COLOR_NEUTRAL}),
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
                                    html.P([html.B("Definición:"), " Representación gráfica de la evolución del capital."]),
                                    html.P([html.B("Fórmula:"), " Equity_actual = Balance_inicial + Suma(PnL)"])
                                ], title="Equity Curve"),

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
                                    html.P([html.B("Definición:"), " Nivel de precio que invalida la operación y limita la pérdida."]),
                                    html.P("En este sistema, la distancia (Entrada - SL) define la unidad de riesgo '1R'.")
                                ], title="Stop Loss (SL)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Punto donde la operación no gana ni pierde (Entrada = Salida)."])
                                ], title="Break Even (BE)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Porcentaje teórico de capital a arriesgar para maximizar el crecimiento geométrico."]),
                                    html.P([html.B("Fórmula:"), " K% = (W * (B + 1) - 1) / B"])
                                ], title="Criterio de Kelly"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Tasa a la cual crece el capital compuesto dado un riesgo 'f'."]),
                                    html.P([html.B("Fórmula:"), " G(f) = [(1 + f*B)^W * (1 - f)^L] - 1"]),
                                    html.Ul([
                                        html.Li([html.B("W:"), " Win rate (Tasa de aciertos)."]),
                                        html.Li([html.B("L:"), " Loss rate (Tasa de pérdidas)."]),
                                        html.Li([html.B("B:"), " Ratio Riesgo / Beneficio."])
                                    ])
                                ], title="Tasa de Crecimiento Geométrico G(f)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Mayor caída porcentual desde un pico histórico hasta un valle."]),
                                    html.P([html.B("Fórmula:"), " (Valle - Pico Previo) / Pico Previo"])
                                ], title="Máximo Drawdown (MDD)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Tiempo (medido en días) que el portafolio pasa en estado de Drawdown."]),
                                    html.P("Cuenta los días desde que el capital cae por debajo de su último máximo histórico hasta que logra superarlo nuevamente."),
                                    html.P("Es una medida clave para entender la paciencia y disciplina requerida por un sistema.")
                                ], title="Time Under Water (TUW)"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Mide el rendimiento adicional generado por cada unidad de riesgo (volatilidad total) asumida."]),
                                    html.P([html.B("Fórmula:"), " (Retorno Anualizado - Tasa Libre de Riesgo) / Desviación Estándar de los Retornos."]),
                                    html.P("Un Sharpe superior a 1.0 se considera bueno; mayor a 2.0 es excelente.")
                                ], title="Sharpe Ratio"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Similar al Sharpe Ratio, pero solo penaliza la volatilidad negativa (caídas)."]),
                                    html.P([html.B("Fórmula:"), " (Retorno Anualizado - Tasa Libre de Riesgo) / Desviación Estándar de Retornos a la baja."]),
                                    html.P("Suele ser más representativo para traders que buscan asimetría positiva en sus retornos.")
                                ], title="Sortino Ratio"),

                                dbc.AccordionItem([
                                    html.P([html.B("Beta (β):"), " Sensibilidad del portafolio frente al mercado (SPY). Un β de 1.2 significa que el portafolio es un 20% más volátil que el mercado."]),
                                    html.P([html.B("Alpha de Jensen (α):"), " Rendimiento excedente generado por la estrategia que no puede ser explicado por el riesgo sistémico (Beta)."]),
                                    html.P([html.B("Fórmula Alpha:"), " (Retorno del Portafolio - Tasa Libre) - [ Beta * (Retorno del Mercado - Tasa Libre) ]"])
                                ], title="Alpha de Jensen & Beta"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Histograma de frecuencia de resultados monetarios."]),
                                    html.P([html.B("Asimetría Positiva:"), " Cola extendida hacia la derecha (ganancias grandes, pérdidas controladas)."])
                                ], title="Distribución y Asimetría"),

                                dbc.AccordionItem([
                                    html.P([html.B("Definición:"), " Límite del 'peor escenario razonable' (95% de confianza)."]),
                                    html.P("Indica que en el 95% de las simulaciones, el Drawdown no superó este nivel.")
                                ], title="Value at Risk (VaR 95%)")

                            ], start_collapsed=True, flush=True)
                        ])
                    ], style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER_COLOR}"})
                ], width=6),
                
            ]),

            # --- NUEVA SECCIÓN: FIRMA DE AUTOR ---
            html.Div([
                html.Hr(style={"borderColor": BORDER_COLOR, "margin": "30px 0 15px 0"}),
                html.P([
                    "Creado por ", html.B("Mirko Gulin"), " | Mail de contacto: ",
                    html.A("gulinmirko@gmail.com", href="mailto:gulinmirko@gmail.com", style={"color": COLOR_POS, "textDecoration": "none"}),
                    html.Br(),
                    "Refina tu edge en Edge Terminal: ",
                    html.A("https://edge-terminal.streamlit.app/", href="https://edge-terminal.streamlit.app/", target="_blank", style={"color": COLOR_POS, "textDecoration": "none", "fontWeight": "bold"})
                ])
            ], className="text-center", style={"fontSize": "0.8rem", "color": COLOR_NEUTRAL, "fontFamily": "Consolas, monospace", "paddingBottom": "20px"})
            
        ])
    return html.Div()

# --- CALLBACKS GESTIÓN HISTORIAL ---
@app.callback([Output('history-grid', 'rowData'), Output('hist-msg', 'children')], [Input('btn-del-sel-hist', 'n_clicks'), Input('confirm-del-all', 'submit_n_clicks')], [State('history-grid', 'selectedRows'), State('session-store', 'data')])
def manage_history(n_sel, n_all, selected, session):
    ctx_id = ctx.triggered_id
    if not session: return no_update, ""
    user = session['user']
    if ctx_id == 'btn-del-sel-hist':
        if not selected: return no_update, "Seleccion requerida."
        if db.delete_trade(selected[0]['id']):
            df = db.get_closed_trades(user)
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
        if db.delete_all_closed_trades(user): return [], "BD limpiada."
        return no_update, "Error BD."
    return no_update, ""

# --- CALLBACKS ANALYTICS ---
@app.callback([Output("fig-equity", "figure"), Output("fig-dd", "figure"), Output("fig-portfolio", "figure"), Output("fig-edge", "figure"), Output("fig-hist", "figure"), Output("kpi-container", "children"), Output("fig-strategy", "figure"), Output("fig-count", "figure"), Output("fig-evo-winrate", "figure"), Output("fig-evo-ratio", "figure")], [Input("initial-balance-input", "value"), Input("strategy-selector", "value"), Input("session-store", "data")])
def update_analytics(start_bal, selected_metric, session):
    if not session: return {}, {}, {}, {}, {}, [], {}, {}, {}, {}
    try:
        capital_final = float(start_bal[0] if isinstance(start_bal, list) else start_bal)
    except:
        capital_final = 10000.0
        
    df_closed = db.get_closed_trades(session['user'])
    df_open = db.get_open_trades(session['user'])
    return get_analytics_figures(df_closed, df_open, capital_final, session.get('config', {}), selected_metric)

# --- CALLBACK GRAFICO RIESGO LIVE ---
@app.callback(Output("fig-live-risk", "figure"), [Input("live-chart-mode-selector", "value"), Input("open-grid", "rowData")], [State("session-store", "data")])
def update_live_risk_chart(mode, rows, session):
    if not session or not rows:
        fig = go.Figure()
        fig.update_layout(paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=COLOR_NEUTRAL, font_family="Consolas, monospace", xaxis=dict(visible=False), yaxis=dict(visible=False))
        return fig

    df = pd.DataFrame(rows)
    if df.empty: return go.Figure()

    if 'unrealized_pnl' not in df.columns: df['unrealized_pnl'] = 0.0
    if 'open_risk' not in df.columns: df['open_risk'] = 0.0

    for col in ['unrealized_pnl', 'open_risk']:
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    fig = go.Figure()

    if mode == 'TOTAL':
        total_pnl = df['unrealized_pnl'].sum()
        total_risk = df['open_risk'].sum()
        
        x_cats = ['PNL LATENTE', 'RIESGO VIVO']
        fig.add_trace(go.Bar(
            x=x_cats,
            y=[total_pnl, total_risk],
            marker_color=[COLOR_POS if total_pnl >= 0 else COLOR_NEG, COLOR_NEG],
            text=[f"${total_pnl:,.0f}", f"${total_risk:,.0f}"],
            textposition='auto',
        ))
    
    else: 
        df_grouped = df.groupby('symbol')[['unrealized_pnl', 'open_risk']].sum().reset_index()
        x_cats = sorted(df_grouped['symbol'].tolist()) 
        
        fig.add_trace(go.Bar(
            name='PnL Latente',
            x=df_grouped['symbol'],
            y=df_grouped['unrealized_pnl'],
            marker_color=np.where(df_grouped['unrealized_pnl'] >= 0, COLOR_POS, COLOR_NEG),
            text=df_grouped['unrealized_pnl'].apply(lambda val: f"${val:,.0f}"),
            textposition='auto'
        ))

        fig.add_trace(go.Bar(
            name='Riesgo Vivo',
            x=df_grouped['symbol'],
            y=df_grouped['open_risk'],
            marker_color=COLOR_NEG,
            text=df_grouped['open_risk'].apply(lambda val: f"${val:,.0f}"),
            textposition='auto'
        ))
        fig.update_layout(barmode='group')

    fig.update_layout(
        paper_bgcolor=CARD_BG, 
        plot_bgcolor=CARD_BG, 
        font_color=TEXT_MAIN,
        font_family="Consolas, monospace",
        margin=dict(l=20, r=20, t=20, b=20),
        yaxis=dict(showgrid=True, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR, title="USD"),
        xaxis=dict(showgrid=False, gridcolor=BORDER_COLOR, zerolinecolor=BORDER_COLOR, type='category', categoryarray=x_cats),
        showlegend=False,
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
        df_open = db.get_open_trades(s['user'])
        if not df_open.empty: df_open = calculate_live_metrics(df_open)
        return "Orden ingresada.", format_df(df_open, s.get('config', {})), no_update
        
    return no_update, no_update, no_update

@app.callback([Output("management-container", "style"), Output("selected-trade-store", "data"), Output("dyn-info", "children"), Output("usl", "value")], Input("open-grid", "selectedRows"))
def toggle(sel):
    return ({'display': 'block'}, sel[0], f"SELECCION: {sel[0]['symbol']}", sel[0]['current_stop_loss']) if sel else ({'display': 'none'}, None, "", "")

@app.callback([Output('g-msg', 'children', allow_duplicate=True), Output('open-grid', 'rowData', allow_duplicate=True), Output("management-container", "style", allow_duplicate=True), Output("open-grid", "selectedRows")], [Input('btn-close', 'n_clicks'), Input('btn-part', 'n_clicks'), Input('btn-sl', 'n_clicks'), Input('btn-del', 'n_clicks'), Input('confirm-del-all-open', 'submit_n_clicks')], [State('selected-trade-store', 'data'), State('cp', 'value'), State('cd', 'value'), State('cr', 'value'), State('pq', 'value'), State('pp', 'value'), State('usl', 'value'), State('c-notes', 'value'), State('session-store', 'data')], prevent_initial_call=True)
def manage(b1, b2, b3, b4, b_all, trade, cp, cd, cr, pq, pp, usl, c_notes, s):
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
    elif cid == 'btn-part': db.close_partial(tid, pq, pp, date.today())
    elif cid == 'btn-sl': db.update_stop_loss(tid, usl)
    elif cid == 'btn-del': db.delete_trade(tid)
    
    df_open = db.get_open_trades(s['user'])
    if not df_open.empty: df_open = calculate_live_metrics(df_open)
    return "Actualizado.", format_df(df_open, s.get('config', {})), {'display': 'none'}, []

@app.callback(
    [
        Output("fig-perf-cumulative", "figure"),
        Output("fig-perf-drawdown", "figure"),
        Output("perf-kpis-container", "children"),
        Output("perf-status", "children")
    ],
    [
        Input("btn-calc-performance", "n_clicks"), 
        Input("tabs", "value"),
        Input("perf-period-selector", "value")
    ],
    [State("session-store", "data")]
)
def update_performance(n_clicks, active_tab, period_value, session):
    """Calcula el portfolio, filtra por periodo y compara vs Benchmark (SPY)."""
    
    empty_fig = go.Figure()
    empty_fig.update_layout(paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=COLOR_NEUTRAL, xaxis=dict(visible=False), yaxis=dict(visible=False))
    
    if active_tab != 'tab-performance' or not session:
        return empty_fig, empty_fig, [], ""
    
    # 1. Configuración Inicial
    config = session.get('config', {})
    try:
        initial_balance = float(config.get('initial_balance', 10000))
        if initial_balance <= 0: initial_balance = 10000
    except: initial_balance = 10000.0

    df_closed = db.get_closed_trades(session['user'])
    if df_closed.empty:
        return empty_fig, empty_fig, [], html.Div("⚠️ Sin historial cerrado.", style={"color": COLOR_SPY})
    
    # 2. Calcular Portfolio Completo
    try:
        daily_df = build_daily_portfolio(df_closed, initial_balance)
        if daily_df.empty: return empty_fig, empty_fig, [], "⚠️ Error calculando portfolio."
    except Exception as e:
        return empty_fig, empty_fig, [], f"⚠️ Error: {str(e)}"
    
    # 3. Benchmark SPY
    try:
        start_date_all = daily_df['date'].min()
        end_date_all = daily_df['date'].max()
        spy_raw = yf.download("SPY", start=start_date_all, end=end_date_all + timedelta(days=3), progress=False, auto_adjust=True)
        
        if not spy_raw.empty:
            if isinstance(spy_raw.columns, pd.MultiIndex):
                try: spy_series = spy_raw.xs('Close', level=0, axis=1)['SPY']
                except: spy_series = spy_raw.iloc[:, 0]
            else:
                col = 'Close' if 'Close' in spy_raw.columns else spy_raw.columns[0]
                spy_series = spy_raw[col]
            spy_aligned = spy_series.reindex(daily_df['date']).ffill()
            daily_df['spy_price'] = spy_aligned.values
        else: daily_df['spy_price'] = np.nan
    except: daily_df['spy_price'] = np.nan

    # 4. Filtrado por Periodo
    daily_df['date'] = pd.to_datetime(daily_df['date'])
    today = pd.Timestamp.today()
    start_filter = daily_df['date'].min()
    end_filter = daily_df['date'].max()
    period_label = "HISTÓRICO"

    if period_value == 'YTD':
        start_filter = datetime(today.year, 1, 1)
        period_label = f"YTD ({today.year})"
    elif period_value == 'LAST_YEAR':
        start_filter = datetime(today.year - 1, 1, 1)
        end_filter = datetime(today.year - 1, 12, 31)
        period_label = f"AÑO {today.year - 1}"
    elif period_value == '3M':
        start_filter = today - timedelta(days=90)
        period_label = "ÚLTIMOS 90 DÍAS"

    mask = (daily_df['date'] >= pd.Timestamp(start_filter)) & (daily_df['date'] <= pd.Timestamp(end_filter))
    period_df = daily_df.loc[mask].copy()
    
    if period_df.empty: return empty_fig, empty_fig, [], html.Div(f"⚠️ Sin datos para {period_label}", style={"color": "orange"})

    # 5. Métricas y Normalización
    p_start = period_df['total_value'].iloc[0]
    period_df['norm_port'] = ((period_df['total_value'] / p_start) - 1) * 100
    
    if 'spy_price' in period_df.columns and not period_df['spy_price'].isnull().all():
        s_start = period_df['spy_price'].iloc[0]
        period_df['norm_spy'] = ((period_df['spy_price'] / s_start) - 1) * 100
    else: period_df['norm_spy'] = 0.0

    # Drawdowns
    dd_port_raw = (period_df['total_value'] / period_df['total_value'].cummax()) - 1
    max_dd_port = dd_port_raw.min() * 100
    
    dd_spy_raw = (period_df['spy_price'] / period_df['spy_price'].cummax()) - 1
    max_dd_spy = dd_spy_raw.min() * 100

    # Retornos Diarios
    port_rets = period_df['total_value'].pct_change().fillna(0)
    spy_rets = period_df['spy_price'].pct_change().fillna(0)
    rfr_daily = 0.04 / 252
    
    # Función Sharpe
    def calc_sharpe(rets):
        if rets.std() == 0: return 0
        return np.sqrt(252) * (rets.mean() - rfr_daily) / rets.std()
        
    # Función Sortino (Solo penaliza la volatilidad negativa)
    def calc_sortino(rets):
        downside = rets[rets < 0]
        if len(downside) < 2: return 0
        down_std = downside.std()
        if down_std == 0: return 0
        return np.sqrt(252) * (rets.mean() - rfr_daily) / down_std
    
    sharpe_port = calc_sharpe(port_rets)
    sharpe_spy = calc_sharpe(spy_rets)
    
    sortino_port = calc_sortino(port_rets)
    sortino_spy = calc_sortino(spy_rets)
    
    try:
        cov = np.cov(port_rets, spy_rets)
        beta = cov[0, 1] / cov[1, 1]
        alpha = (port_rets.mean() - rfr_daily) - beta * (spy_rets.mean() - rfr_daily)
        alpha *= 252 * 100
    except: beta, alpha = 1.0, 0.0

    # Time Under Water
    is_underwater = dd_port_raw < -0.0001
    g = (is_underwater != is_underwater.shift()).cumsum()
    underwater_streaks = is_underwater.groupby(g).sum()
    streaks = underwater_streaks[underwater_streaks > 0]
    
    max_tuw = streaks.max() if not streaks.empty else 0
    avg_tuw = streaks.mean() if not streaks.empty else 0

    # 6. Tarjetas KPI (AHORA CON EL ESTILO DE ANALYTICS)
    def make_perf_card(title, main_val_str, sub_text=None, m_color=None):
        v_style = KPI_VAL_STYLE.copy()
        v_style['fontWeight'] = 'normal' # Mantenemos tu pedido de formato normal (no negrita)
        if m_color: v_style['color'] = m_color
        
        content = [
            html.P(main_val_str, style=v_style),
            html.P(title, style=KPI_LBL_STYLE)
        ]
        
        if sub_text:
            content.append(html.P(sub_text, style={"color": COLOR_NEUTRAL, "fontSize": "0.7rem", "marginTop": "6px", "marginBottom": "0", "fontFamily": "Consolas, monospace"}))
            
        # Utilizamos KPI_CARD_STYLE global para que sean cuadros oscuros
        return dbc.Col(html.Div(content, style=KPI_CARD_STYLE), width="auto", className="mb-2 p-1")

    # Contenedor horizontal con scroll (igual que Analytics)
    kpis_layout = html.Div(dbc.Row([
        make_perf_card("RETORNO", f"{period_df['norm_port'].iloc[-1]:+.2f}%", f"SPY: {period_df['norm_spy'].iloc[-1]:+.2f}%", COLOR_POS if period_df['norm_port'].iloc[-1] >= 0 else COLOR_NEG),
        make_perf_card("MAX DRAWDOWN", f"{max_dd_port:.2f}%", f"SPY: {max_dd_spy:.2f}%", COLOR_NEG),
        make_perf_card("SHARPE RATIO", f"{sharpe_port:.2f}", f"SPY: {sharpe_spy:.2f}", TEXT_MAIN),
        make_perf_card("SORTINO RATIO", f"{sortino_port:.2f}", f"SPY: {sortino_spy:.2f}", TEXT_MAIN), # NUEVO
        make_perf_card("ALPHA (JENSEN)", f"α {alpha:+.2f}%", "Exceso vs Riesgo", COLOR_SPY),
        make_perf_card("BETA", f"β {beta:.2f}", "Sensibilidad vs SPY", TEXT_MAIN),
        make_perf_card("TIME UNDER WATER", f"{max_tuw:.0f} Max", f"{avg_tuw:.0f} Promedio (Días)", COLOR_NEG if max_tuw > 0 else TEXT_MAIN),
        make_perf_card("DÍAS OPERADOS", f"{len(period_df)}", period_label, TEXT_MAIN)
    ], className="flex-nowrap g-3", style={"padding": "10px 5px"}), style=SCROLL_CONTAINER_STYLE)

    # 7. Gráficos
    fig_cum = go.Figure()
    fig_cum.add_trace(go.Scatter(x=period_df['date'], y=period_df['norm_spy'], mode='lines', line=dict(color='#555555', width=1, dash='dash'), name='SPY'))
    fig_cum.add_trace(go.Scatter(x=period_df['date'], y=period_df['norm_port'], mode='lines', line=dict(color=COLOR_POS, width=2), fill='tozeroy', fillcolor=f'rgba(0, 176, 189, 0.1)', name='Portfolio'))
    fig_cum.add_hline(y=0, line_color=COLOR_NEUTRAL, opacity=0.3)
    fig_cum.update_layout(
        title={'text': f'RETORNO ACUMULADO - {period_label}', 'font': {'size': 14, 'color': TEXT_MAIN, 'family': 'Consolas'}, 'x': 0.05, 'xanchor': 'left'},
        paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=TEXT_MAIN, font_family="Consolas",
        hovermode='x unified', margin=dict(l=40, r=20, t=40, b=10),
        yaxis=dict(showgrid=True, gridcolor=BORDER_COLOR, ticksuffix='%'), xaxis=dict(showgrid=False, gridcolor=BORDER_COLOR),
        legend=dict(orientation="h", y=1.02, x=1, xanchor="right"), height=450
    )

    fig_dd = go.Figure()
    fig_dd.add_trace(go.Scatter(x=period_df['date'], y=dd_port_raw*100, mode='lines', line=dict(color=COLOR_NEG, width=1), fill='tozeroy', fillcolor='rgba(246, 70, 93, 0.2)', name='Drawdown'))
    fig_dd.update_layout(
        title={'text': 'EVOLUCIÓN DEL DRAWDOWN', 'font': {'size': 14, 'color': TEXT_MAIN, 'family': 'Consolas'}, 'x': 0.05, 'xanchor': 'left'},
        paper_bgcolor=CARD_BG, plot_bgcolor=CARD_BG, font_color=TEXT_MAIN, font_family="Consolas",
        hovermode='x unified', margin=dict(l=40, r=20, t=40, b=40),
        yaxis=dict(showgrid=True, gridcolor=BORDER_COLOR, ticksuffix='%'), xaxis=dict(showgrid=False, gridcolor=BORDER_COLOR),
        showlegend=False, height=250
    )
    
    return fig_cum, fig_dd, kpis_layout, ""
# --- CALLBACK GLOBAL: MARKET PILLS EN EL HEADER ---
@app.callback(
    Output("top-market-pills", "children"),
    [Input("tabs", "value"), Input("g-msg", "children")],
    [State("session-store", "data")]
)
def update_top_market_pills(tab, g_msg, session):
    if not session or 'user' not in session:
        return html.Div()
    
    # Consultamos la base de datos para ver qué operaciones tienes abiertas AHORA mismo
    df_open = db.get_open_trades(session['user'])
    tickers_list = []
    
    if not df_open.empty:
        # Extraemos los tickers únicos
        tickers_list = [str(t).upper() for t in df_open['symbol'].unique() if pd.notna(t)]
        
    # Llamamos a la función que descarga Yahoo Finance y dibuja los cuadros
    return get_market_pills(tickers_list)
if __name__ == '__main__':
    app.run(debug=True)