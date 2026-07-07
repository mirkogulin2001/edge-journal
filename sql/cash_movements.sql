-- Tabla de aportes y retiros de capital (ejecutar en el SQL Editor de Supabase)
-- Usada por la pestaña Performance para el cálculo de retorno time-weighted (TWR).

CREATE TABLE cash_movements (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    movement_date DATE NOT NULL,
    amount NUMERIC(15,2) NOT NULL,          -- siempre positivo
    movement_type TEXT NOT NULL,             -- 'APORTE' o 'RETIRO'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cash_movements_user ON cash_movements(username);
