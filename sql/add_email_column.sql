-- Columna de email en users (ejecutar en el SQL Editor de Supabase ANTES de
-- mergear el feature de recuperación de contraseña; sin ella el registro falla).
-- Los usuarios existentes quedan con email vacío: pueden seguir operando pero
-- no podrán usar la recuperación hasta que se les cargue un email.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';
