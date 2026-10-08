CREATE TABLE `coupons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`discount_type` enum('percent','fixed') NOT NULL,
	`discount_value` int NOT NULL,
	`starts_at` datetime,
	`ends_at` datetime,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupons_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `plans` ADD `is_active` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `coupon_id` int;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `discount_amount` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_coupon_id_coupons_id_fk`
	FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
