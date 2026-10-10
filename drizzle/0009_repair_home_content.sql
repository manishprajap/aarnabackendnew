CREATE TABLE IF NOT EXISTS `home_content` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `content_type` enum('banner', 'news') NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text,
  `media_url` varchar(1000),
  `media_type` enum('image', 'video', 'text', 'none') NOT NULL DEFAULT 'text',
  `button_text` varchar(100),
  `button_url` varchar(1000),
  `news_url` varchar(1000),
  `display_order` int NOT NULL DEFAULT 0,
  `is_active` boolean NOT NULL DEFAULT true,
  `start_date` datetime,
  `end_date` datetime,
  `created_by` bigint unsigned,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `home_content_id` PRIMARY KEY (`id`),
  INDEX `idx_home_content_type_order` (`content_type`, `display_order`),
  INDEX `idx_home_content_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @add_news_url_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `home_content` ADD COLUMN `news_url` varchar(1000) NULL AFTER `button_url`',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'home_content'
    AND COLUMN_NAME = 'news_url'
);
PREPARE add_news_url_stmt FROM @add_news_url_sql;
EXECUTE add_news_url_stmt;
DEALLOCATE PREPARE add_news_url_stmt;

ALTER TABLE `home_content`
  MODIFY COLUMN `media_type` enum('image', 'video', 'text', 'none') NOT NULL DEFAULT 'text';
