SET @add_ai_auto_reply_enabled_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `whatsapp_connections` ADD COLUMN `ai_auto_reply_enabled` boolean NOT NULL DEFAULT false',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_connections'
    AND COLUMN_NAME = 'ai_auto_reply_enabled'
);
PREPARE add_ai_auto_reply_enabled_stmt FROM @add_ai_auto_reply_enabled_sql;
EXECUTE add_ai_auto_reply_enabled_stmt;
DEALLOCATE PREPARE add_ai_auto_reply_enabled_stmt;

SET @add_ai_instructions_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `whatsapp_connections` ADD COLUMN `ai_instructions` text NULL',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_connections'
    AND COLUMN_NAME = 'ai_instructions'
);
PREPARE add_ai_instructions_stmt FROM @add_ai_instructions_sql;
EXECUTE add_ai_instructions_stmt;
DEALLOCATE PREPARE add_ai_instructions_stmt;
