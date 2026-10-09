ALTER TABLE `otps` ADD `email` varchar(191);
--> statement-breakpoint
ALTER TABLE `plans` ADD `duration_days` int NOT NULL DEFAULT 30;
--> statement-breakpoint
INSERT INTO `plans` (`name`, `price`, `posters`, `features`, `duration_days`, `is_active`)
SELECT
	'Basic Plan',
	999,
	30,
	'30 AI banner generations per month\nPublish to connected social accounts\nBusiness profile and logo setup',
	30,
	true
WHERE NOT EXISTS (
	SELECT 1 FROM `plans` WHERE `name` = 'Basic Plan'
);
