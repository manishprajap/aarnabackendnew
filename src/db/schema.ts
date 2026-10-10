import {
  mysqlTable,
  varchar,
  text,
  int,
  bigint,
  decimal,
  timestamp,
  datetime,
  mysqlEnum,
  boolean,
  json,
  date,
  index,
  uniqueIndex,
  primaryKey,
  mysqlView,
} from 'drizzle-orm/mysql-core';

import { relations, sql } from 'drizzle-orm';

/* =========================================================
   USERS / AUTH
========================================================= */

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 191 }),
  mobile: varchar('mobile', { length: 20 }).unique(),
  email: varchar('email', { length: 191 }).unique(),
  password: varchar('password', { length: 255 }),
  image: int('image'),
  businessName: varchar('business_name', { length: 190 }),
  website: varchar('website', { length: 255 }),
  logo: varchar('logo', { length: 255 }),
  country: varchar('country', { length: 100 }).default('India'),
  state: varchar('state', { length: 100 }),
  city: varchar('city', { length: 100 }),
  business_category: varchar('business_category', { length: 100 }),
  industryId: int('industry_id'),
  businessCategoryId: int('business_category_id'),
  automationMode: mysqlEnum('automation_mode', ['AUTO', 'MANUAL']).notNull().default('AUTO'),
  primaryGoal: mysqlEnum('primary_goal', ['LEADS', 'SALES', 'AWARENESS', 'ENGAGEMENT', 'TRAFFIC'])
    .notNull()
    .default('LEADS'),
  customPrompt: text('custom_prompt'),
  plan: varchar('plan', { length: 50 }).default('free'),
  credits: int('credits').default(2),
  language: varchar('language', { length: 50 }).default('Hinglish'),
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  status: mysqlEnum('status', ['ACTIVE', 'INACTIVE', 'SUSPENDED']).notNull().default('ACTIVE'),
  googleConnected: boolean('google_connected').default(false),
  facebookConnected: boolean('facebook_connected').default(false),
  instagramConnected: boolean('instagram_connected').default(false),
  whatsappConnected: boolean('whatsapp_connected').default(false),
  deviceId: varchar('device_id', { length: 191 }),
  deviceType: varchar('device_type', { length: 50 }),
  deviceName: varchar('device_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
    marketingGoal: varchar('marketing_goal', { length: 100 }),
  strategyId: bigint('strategy_id', { mode: 'number', unsigned: true }),
});

export const otps = mysqlTable(
  'otps',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    mobile: varchar('mobile', { length: 15 }).notNull(),
    email: varchar('email', { length: 191 }),
    otp: varchar('otp', { length: 6 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    mobileIdx: index('idx_otps_mobile').on(table.mobile),
    expiresIdx: index('idx_otps_expires_at').on(table.expiresAt),
  })
);

/* =========================================================
   CATEGORIES
========================================================= */

export const categories = mysqlTable('categories', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  icon: varchar('icon', { length: 64 }),
  sortOrder: int('sort_order').default(0),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const subcategories = mysqlTable('subcategories', {
  id: int('id').autoincrement().primaryKey(),
  categoryId: int('category_id').notNull().references(() => categories.id),
  name: varchar('name', { length: 100 }).notNull(),
  sortOrder: int('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

export const childCategories = mysqlTable('child_categories', {
  id: int('id').autoincrement().primaryKey(),
  subcategoryId: int('subcategory_id').notNull().references(() => subcategories.id),
  name: varchar('name', { length: 100 }).notNull(),
  sortOrder: int('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

export const categoriesRelations = relations(categories, ({ many }) => ({
  subcategories: many(subcategories),
  presets: many(adPresets),
}));

export const subcategoriesRelations = relations(subcategories, ({ one, many }) => ({
  category: one(categories, {
    fields: [subcategories.categoryId],
    references: [categories.id],
  }),
  childCategories: many(childCategories),
}));

export const childCategoriesRelations = relations(childCategories, ({ one }) => ({
  subcategory: one(subcategories, {
    fields: [childCategories.subcategoryId],
    references: [subcategories.id],
  }),
}));

/* =========================================================
   PRODUCTS / BANNERS
========================================================= */

export const products = mysqlTable('products', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  categoryId: int('category_id').references(() => categories.id),
  subcategoryId: int('subcategory_id').references(() => subcategories.id),
  childCategoryId: int('child_category_id'),
  originalImageUrl: varchar('original_image_url', { length: 500 }).notNull(),
  cleanImageUrl: varchar('clean_image_url', { length: 500 }),
  brand: varchar('brand', { length: 191 }),
  companyName: varchar('company_name', { length: 191 }),
  title: varchar('title', { length: 255 }),
  description: text('description'),
  price: varchar('price', { length: 100 }),
  aspectRatio: varchar('aspect_ratio', { length: 16 }).default('1:1'),
  category: varchar('category', { length: 100 }),
  subcategory: varchar('subcategory', { length: 100 }),
  color: varchar('color', { length: 100 }),
  features: text('features'),
  keywords: text('keywords'),
  hashtags: text('hashtags'),
  visibleText: text('visible_text'),
  metaDescription: text('meta_description'),
  confidence: int('confidence'),
  prompt: text('prompt'),
  promptType: varchar('prompt_type', { length: 100 }),
  bannerColor: varchar('banner_color', { length: 20 }),
  status: mysqlEnum('status', ['processing', 'done', 'failed']).default('processing').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const banners = mysqlTable('banners', {
  id: int('id').autoincrement().primaryKey(),
  productId: int('product_id').notNull().references(() => products.id),
  day: int('day').notNull(),
  theme: varchar('theme', { length: 100 }),
  imageUrl: varchar('image_url', { length: 500 }).notNull(),
  caption: text('caption'),
  posted: boolean('posted').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const bannerPublications = mysqlTable(
  'banner_publications',
  {
    id: int('id').autoincrement().primaryKey(),
    bannerId: int('banner_id').notNull().references(() => banners.id, { onDelete: 'cascade' }),
    userId: int('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 40 }).notNull(),
    externalId: varchar('external_id', { length: 500 }).notNull(),
    permalink: varchar('permalink', { length: 1000 }),
    publishedAt: timestamp('published_at').defaultNow().notNull(),
  },
  (table) => ({
    userBannerIndex: index('idx_banner_publications_user_banner').on(table.userId, table.bannerId),
  })
);

export const productsRelations = relations(products, ({ one, many }) => ({
  user: one(users, { fields: [products.userId], references: [users.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  subcategory: one(subcategories, {
    fields: [products.subcategoryId],
    references: [subcategories.id],
  }),
  banners: many(banners),
  adCreatives: many(adCreatives),
}));

export const bannersRelations = relations(banners, ({ one }) => ({
  product: one(products, { fields: [banners.productId], references: [products.id] }),
}));

/* =========================================================
   AD PRESETS / SUGGESTIONS / CREATIVES
========================================================= */

export const adPresets = mysqlTable('ad_presets', {
  id: int('id').autoincrement().primaryKey(),
  presetKey: varchar('preset_key', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  group: varchar('group', { length: 32 }).notNull(), // "style" | "creative_type"
  categoryId: int('category_id').references(() => categories.id), // null = universal
  aspectRatio: varchar('aspect_ratio', { length: 16 }).notNull().default('1:1'),
  promptModifier: text('prompt_modifier').notNull(),
  requiresOffer: boolean('requires_offer').default(false),
  icon: varchar('icon', { length: 64 }),
  sortOrder: int('sort_order').default(0),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const adSuggestions = mysqlTable('ad_suggestions', {
  id: int('id').autoincrement().primaryKey(),
  productId: int('product_id').notNull(),
  title: varchar('title', { length: 128 }).notNull(),
  category: varchar('category', { length: 32 }).notNull(),
  aspectRatio: varchar('aspect_ratio', { length: 16 }).notNull().default('1:1'),
  promptModifier: text('prompt_modifier').notNull(),
  requiresOffer: boolean('requires_offer').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

export const adCreatives = mysqlTable('ad_creatives', {
  id: int('id').autoincrement().primaryKey(),
  productId: int('product_id').notNull().references(() => products.id),
  presetId: int('preset_id').references(() => adPresets.id),
  suggestionId: int('suggestion_id').references(() => adSuggestions.id),
  presetKey: varchar('preset_key', { length: 64 }),
  platform: varchar('platform', { length: 32 }),
  price: varchar('price', { length: 64 }),
  discount: varchar('discount', { length: 64 }),
  phone: varchar('phone', { length: 64 }),
  website: varchar('website', { length: 256 }),
  cta: varchar('cta', { length: 128 }),
  logoImageUrl: varchar('logo_image_url', { length: 512 }),
  imageUrl: varchar('image_url', { length: 512 }),
  status: mysqlEnum('status', ['processing', 'done', 'failed']).default('processing').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const adPresetsRelations = relations(adPresets, ({ one, many }) => ({
  category: one(categories, { fields: [adPresets.categoryId], references: [categories.id] }),
  creatives: many(adCreatives),
}));

export const adCreativesRelations = relations(adCreatives, ({ one }) => ({
  product: one(products, { fields: [adCreatives.productId], references: [products.id] }),
  preset: one(adPresets, { fields: [adCreatives.presetId], references: [adPresets.id] }),
}));

/* =========================================================
   PLANS / SUBSCRIPTIONS / TRANSACTIONS
========================================================= */

export const coupons = mysqlTable('coupons', {
  id: int('id').autoincrement().primaryKey(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  discountType: mysqlEnum('discount_type', ['percent', 'fixed']).notNull(),
  discountValue: int('discount_value').notNull(),
  startsAt: datetime('starts_at', { mode: 'date' }),
  endsAt: datetime('ends_at', { mode: 'date' }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const homeContent = mysqlTable('home_content', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  contentType: mysqlEnum('content_type', ['banner', 'news']).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  mediaUrl: varchar('media_url', { length: 1000 }),
  mediaType: mysqlEnum('media_type', ['image', 'video', 'text', 'none']).notNull().default('text'),
  buttonText: varchar('button_text', { length: 100 }),
  buttonUrl: varchar('button_url', { length: 1000 }),
  newsUrl: varchar('news_url', { length: 1000 }),
  displayOrder: int('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  startDate: datetime('start_date'),
  endDate: datetime('end_date'),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

// `durationDays` lets the subscription API compute a subscription's endDate.
export const plans = mysqlTable('plans', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  price: int('price').notNull(),
  posters: int('posters').notNull(),
  features: text('features'),
  durationDays: int('duration_days').notNull().default(30),
  isActive: boolean('is_active').notNull().default(true),
});

// One row per plan period a user has purchased/is on. The currently active
// period is the most recent row with status = 'active' and endDate in future.
export const subscriptions = mysqlTable('subscriptions', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull().references(() => users.id),
  planId: int('plan_id').notNull().references(() => plans.id),
  status: mysqlEnum('status', ['pending', 'active', 'failed', 'cancelled', 'expired'])
    .default('pending')
    .notNull(),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
});

// One row per Razorpay order attempt (payment audit log).
export const transactions = mysqlTable(
  'transactions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id').notNull().references(() => users.id),
    planId: int('plan_id').notNull().references(() => plans.id),
    subscriptionId: int('subscription_id').references(() => subscriptions.id),

    razorpayOrderId: varchar('razorpay_order_id', { length: 100 }).notNull(),
    razorpayPaymentId: varchar('razorpay_payment_id', { length: 100 }),
    razorpaySignature: varchar('razorpay_signature', { length: 255 }),
    couponId: int('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),
    discountAmount: int('discount_amount').notNull().default(0),

    amount: int('amount').notNull(), // stored in paise (₹1 = 100)
    currency: varchar('currency', { length: 10 }).notNull().default('INR'),

    status: mysqlEnum('status', ['created', 'paid', 'failed']).default('created').notNull(),
    method: varchar('method', { length: 50 }), // card, upi, netbanking, etc.
    errorCode: varchar('error_code', { length: 100 }),
    errorDescription: text('error_description'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    orderIdx: index('idx_transactions_razorpay_order_id').on(table.razorpayOrderId),
    userIdx: index('idx_transactions_user_id').on(table.userId),
  })
);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user: one(users, { fields: [transactions.userId], references: [users.id] }),
  plan: one(plans, { fields: [transactions.planId], references: [plans.id] }),
  subscription: one(subscriptions, {
    fields: [transactions.subscriptionId],
    references: [subscriptions.id],
  }),
}));

/* =========================================================
   INSTAGRAM
========================================================= */

export const instagramConnections = mysqlTable(
  'instagram_connections',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    instagramUserId: varchar('instagram_user_id', { length: 100 }).notNull(),
    instagramUsername: varchar('instagram_username', { length: 255 }),
    instagramName: varchar('instagram_name', { length: 255 }),
    instagramProfilePicture: text('instagram_profile_picture'),
    accessToken: text('access_token').notNull(),
    tokenExpiresAt: timestamp('token_expires_at'),
    status: mysqlEnum('status', ['active', 'expired', 'revoked']).default('active').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    instagramUserUnique: uniqueIndex('uq_instagram_user_id').on(table.instagramUserId),
    userIdIndex: index('idx_instagram_connections_user_id').on(table.userId),
  })
);

export const instagramSelectedTargets = mysqlTable('instagram_selected_targets', {
  userId: int('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  targets: text('targets').notNull(), // JSON string array of instagramUserIds
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const instagramConnectionsRelations = relations(instagramConnections, ({ one }) => ({
  user: one(users, { fields: [instagramConnections.userId], references: [users.id] }),
}));

/* =========================================================
   FACEBOOK
========================================================= */

export const facebookSelectedTargets = mysqlTable('facebook_selected_targets', {
  userId: int('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  targets: text('targets').notNull(), // JSON string array of pageIds
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const facebookConnections = mysqlTable(
  'facebook_connections',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id').notNull(),
    pageId: varchar('page_id', { length: 100 }).notNull(),
    pageName: varchar('page_name', { length: 255 }),
    pageProfilePicture: text('page_profile_picture'),

    /** IMPORTANT: stores the encrypted Facebook Page access token. */
    accessToken: text('access_token').notNull(),

    status: varchar('status', { length: 30 }).notNull().default('active'),

    // Fixed: was `.default(new Date())`, which froze the default at server start.
    connectedAt: datetime('connected_at', { mode: 'date' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),

    lastVerifiedAt: datetime('last_verified_at', { mode: 'date' }),
    tokenExpiresAt: datetime('token_expires_at', { mode: 'date' }),
    lastPublishAt: datetime('last_publish_at', { mode: 'date' }),
    lastError: text('last_error'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => ({
    userPageUnique: uniqueIndex('facebook_connections_user_page_unique').on(
      table.userId,
      table.pageId
    ),
    pageIndex: index('facebook_connections_page_idx').on(table.pageId),
    statusIndex: index('facebook_connections_status_idx').on(table.status),
  })
);

/**
 * OAuth states. Never trust a user ID placed directly inside a
 * client-controlled OAuth state payload.
 */
export const facebookOAuthStates = mysqlTable(
  'facebook_oauth_states',
  {
    id: int('id').autoincrement().primaryKey(),
    stateHash: varchar('state_hash', { length: 128 }).notNull(),
    userId: int('user_id').notNull(),
    expiresAt: datetime('expires_at', { mode: 'date' }).notNull(),
    usedAt: datetime('used_at', { mode: 'date' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    stateUnique: uniqueIndex('facebook_oauth_state_unique').on(table.stateHash),
    userIndex: index('facebook_oauth_user_idx').on(table.userId),
    expiryIndex: index('facebook_oauth_expiry_idx').on(table.expiresAt),
  })
);

export const facebookConnectionsRelations = relations(facebookConnections, ({ one }) => ({
  user: one(users, { fields: [facebookConnections.userId], references: [users.id] }),
}));

/* =========================================================
   WHATSAPP — Embedded Signup connection (one per seller)
========================================================= */

export const whatsappConnections = mysqlTable(
  'whatsapp_connections',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    // WhatsApp Business Account ID (assigned by Meta on Embedded Signup)
    wabaId: varchar('waba_id', { length: 100 }).notNull(),

    // Phone number registered under the WABA — messages are sent FROM this.
    phoneNumberId: varchar('phone_number_id', { length: 100 }).notNull(),

    businessPhoneNumber: varchar('business_phone_number', { length: 32 }),
    businessName: varchar('business_name', { length: 255 }),

    // System user / long-lived access token for this WABA.
    accessToken: text('access_token').notNull(),
    tokenExpiresAt: timestamp('token_expires_at'),

    status: mysqlEnum('status', ['active', 'expired', 'revoked']).default('active').notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userWhatsappUnique: uniqueIndex('uq_user_whatsapp').on(table.userId),
    userIdIndex: index('idx_whatsapp_connections_user_id').on(table.userId),
  })
);

/* =========================================================
   WHATSAPP CONTACTS (merged)
   Serves both purposes:
   - broadcast list (name, phoneNumber, isActive)
   - inbox/CRM contact (waId, profileName, email, avatar, lastSeenAt...)
   `waId` is nullable so a broadcast-only contact can exist before
   the person ever messages you (MySQL allows multiple NULLs in a
   unique index).
========================================================= */

export const whatsappContacts = mysqlTable(
  'whatsapp_contacts',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),

    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    // WhatsApp customer ID (filled once they message / are resolved by Meta)
    waId: varchar('wa_id', { length: 50 }),

    // E.164 format, e.g. 91XXXXXXXXXX (no leading +)
    phoneNumber: varchar('phone_number', { length: 50 }).notNull(),

    name: varchar('name', { length: 191 }),
    profileName: varchar('profile_name', { length: 255 }),
    email: varchar('email', { length: 255 }),
    avatarUrl: text('avatar_url'),

    metadata: json('metadata').$type<Record<string, unknown>>(),

    isActive: boolean('is_active').default(true).notNull(),

    lastSeenAt: timestamp('last_seen_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIndex: index('idx_whatsapp_contacts_user_id').on(table.userId),
    userPhoneUnique: uniqueIndex('uq_user_phone').on(table.userId, table.phoneNumber),
    userWaUnique: uniqueIndex('whatsapp_contacts_user_wa_idx').on(table.userId, table.waId),
  })
);

/* =========================================================
   WHATSAPP CATALOGS
========================================================= */

export const whatsappCatalogs = mysqlTable(
  'whatsapp_catalogs',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    userId: int('user_id').notNull(),

    /** Meta Commerce Manager catalog ID */
    metaCatalogId: varchar('meta_catalog_id', { length: 100 }),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    currency: varchar('currency', { length: 10 }).default('INR'),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdx: index('whatsapp_catalogs_user_idx').on(table.userId),
    metaCatalogIdx: uniqueIndex('whatsapp_catalogs_meta_catalog_idx').on(table.metaCatalogId),
  })
);

export const whatsappCatalogCategories = mysqlTable(
  'whatsapp_catalog_categories',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    catalogId: bigint('catalog_id', { mode: 'number' }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    catalogIdx: index('whatsapp_categories_catalog_idx').on(table.catalogId),
    categoryNameIdx: index('whatsapp_categories_name_idx').on(table.name),
  })
);

export const whatsappProducts = mysqlTable(
  'whatsapp_products',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    catalogId: bigint('catalog_id', { mode: 'number' }).notNull(),
    categoryId: bigint('category_id', { mode: 'number' }),

    /** Meta product item ID */
    metaProductId: varchar('meta_product_id', { length: 100 }),

    /** Retailer SKU / Content ID */
    retailerId: varchar('retailer_id', { length: 100 }),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    price: decimal('price', { precision: 15, scale: 2 }),
    currency: varchar('currency', { length: 10 }).default('INR'),
    imageUrl: text('image_url'),
    additionalImageUrls: json('additional_image_urls').$type<string[]>(),
    availability: varchar('availability', { length: 50 }).default('in stock'),
    condition: varchar('condition', { length: 50 }).default('new'),
    brand: varchar('brand', { length: 255 }),
    url: text('url'),

    /** Extra Meta/product information */
    metadata: json('metadata').$type<Record<string, unknown>>(),

    isActive: boolean('is_active').notNull().default(true),
    syncStatus: varchar('sync_status', { length: 30 }).notNull().default('pending'),
    syncError: text('sync_error'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    catalogIdx: index('whatsapp_products_catalog_idx').on(table.catalogId),
    categoryIdx: index('whatsapp_products_category_idx').on(table.categoryId),
    metaProductIdx: uniqueIndex('whatsapp_products_meta_product_idx').on(table.metaProductId),
    retailerIdx: index('whatsapp_products_retailer_idx').on(table.retailerId),
  })
);

/* =========================================================
   WHATSAPP CONVERSATIONS & MESSAGES
========================================================= */

export const whatsappConversations = mysqlTable(
  'whatsapp_conversations',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    userId: int('user_id').notNull(),
    contactId: bigint('contact_id', { mode: 'number' }).notNull(),

    /** WhatsApp phone number ID used for this conversation */
    phoneNumberId: varchar('phone_number_id', { length: 100 }),

    status: varchar('status', { length: 30 }).notNull().default('open'),
    lastMessageText: text('last_message_text'),
    lastMessageAt: timestamp('last_message_at'),
    unreadCount: int('unread_count').notNull().default(0),
    metadata: json('metadata').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdx: index('whatsapp_conversations_user_idx').on(table.userId),
    contactIdx: index('whatsapp_conversations_contact_idx').on(table.contactId),
    lastMessageIdx: index('whatsapp_conversations_last_message_idx').on(table.lastMessageAt),
  })
);

export const whatsappMessages = mysqlTable(
  'whatsapp_messages',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull(),
    userId: int('user_id').notNull(),

    /** Meta WhatsApp message ID */
    waMessageId: varchar('wa_message_id', { length: 255 }),

    direction: varchar('direction', { length: 20 }).notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    text: text('text'),
    mediaUrl: text('media_url'),
    mimeType: varchar('mime_type', { length: 100 }),
    filename: varchar('filename', { length: 255 }),
    caption: text('caption'),

    /** For product/catalog messages */
    productId: bigint('product_id', { mode: 'number' }),
    metaProductId: varchar('meta_product_id', { length: 100 }),

    status: varchar('status', { length: 30 }).default('pending'),
    errorMessage: text('error_message'),
    metadata: json('metadata').$type<Record<string, unknown>>(),

    sentAt: timestamp('sent_at'),
    deliveredAt: timestamp('delivered_at'),
    readAt: timestamp('read_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    conversationIdx: index('whatsapp_messages_conversation_idx').on(table.conversationId),
    userIdx: index('whatsapp_messages_user_idx').on(table.userId),
    waMessageIdx: uniqueIndex('whatsapp_messages_wa_message_idx').on(table.waMessageId),
    createdIdx: index('whatsapp_messages_created_idx').on(table.createdAt),
  })
);

export const whatsappConnectionsRelations = relations(whatsappConnections, ({ one }) => ({
  user: one(users, { fields: [whatsappConnections.userId], references: [users.id] }),
}));

export const whatsappContactsRelations = relations(whatsappContacts, ({ one, many }) => ({
  user: one(users, { fields: [whatsappContacts.userId], references: [users.id] }),
  conversations: many(whatsappConversations),
}));

export const whatsappCatalogsRelations = relations(whatsappCatalogs, ({ many }) => ({
  categories: many(whatsappCatalogCategories),
  products: many(whatsappProducts),
}));

export const whatsappCatalogCategoriesRelations = relations(
  whatsappCatalogCategories,
  ({ one, many }) => ({
    catalog: one(whatsappCatalogs, {
      fields: [whatsappCatalogCategories.catalogId],
      references: [whatsappCatalogs.id],
    }),
    products: many(whatsappProducts),
  })
);

export const whatsappProductsRelations = relations(whatsappProducts, ({ one }) => ({
  catalog: one(whatsappCatalogs, {
    fields: [whatsappProducts.catalogId],
    references: [whatsappCatalogs.id],
  }),
  category: one(whatsappCatalogCategories, {
    fields: [whatsappProducts.categoryId],
    references: [whatsappCatalogCategories.id],
  }),
}));

export const whatsappConversationsRelations = relations(
  whatsappConversations,
  ({ one, many }) => ({
    contact: one(whatsappContacts, {
      fields: [whatsappConversations.contactId],
      references: [whatsappContacts.id],
    }),
    messages: many(whatsappMessages),
  })
);

export const whatsappMessagesRelations = relations(whatsappMessages, ({ one }) => ({
  conversation: one(whatsappConversations, {
    fields: [whatsappMessages.conversationId],
    references: [whatsappConversations.id],
  }),
}));

/* =========================================================
   SOCIAL ACCOUNTS (Google Business, LinkedIn, YouTube, ...)
   `metadata` is a free-form JSON bag (e.g. Google Business
   { accountId, locationId }); nullable until populated.
========================================================= */

export const socialAccounts = mysqlTable(
  'social_accounts',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    provider: varchar('provider', { length: 40 }).notNull(),
    providerAccountId: varchar('provider_account_id', { length: 160 }),
    accountName: varchar('account_name', { length: 255 }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    metadata: json('metadata').$type<Record<string, unknown>>(),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userProviderUnique: uniqueIndex('uq_social_accounts_user_provider').on(
      table.userId,
      table.provider
    ),
    userIdIndex: index('idx_social_accounts_user_id').on(table.userId),
  })
);

export const socialAccountsRelations = relations(socialAccounts, ({ one }) => ({
  user: one(users, { fields: [socialAccounts.userId], references: [users.id] }),
}));

/* =========================================================
   PROMPT PLANS
========================================================= */

export const promptPlans = mysqlTable(
  'prompt_plans',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    category: varchar('category', { length: 100 }),
    startDate: datetime('start_date', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userUnique: uniqueIndex('uq_prompt_plans_user').on(table.userId),
  })
);

export const promptPlanItems = mysqlTable(
  'prompt_plan_items',
  {
    id: int('id').autoincrement().primaryKey(),
    planId: int('plan_id')
      .notNull()
      .references(() => promptPlans.id, { onDelete: 'cascade' }),

    // property is `day`, DB column is `day_number`
    day: int('day_number').notNull(), // 1..30

    // needs: ALTER TABLE prompt_plan_items ADD COLUMN theme VARCHAR(255) NULL
    theme: varchar('theme', { length: 255 }),

    prompt: text('prompt').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    planDayUnique: uniqueIndex('uq_prompt_plan_items_plan_day').on(table.planId, table.day),
    planIdIndex: index('idx_prompt_plan_items_plan_id').on(table.planId),
  })
);

export const promptPlansRelations = relations(promptPlans, ({ one, many }) => ({
  user: one(users, { fields: [promptPlans.userId], references: [users.id] }),
  items: many(promptPlanItems),
}));

export const promptPlanItemsRelations = relations(promptPlanItems, ({ one }) => ({
  plan: one(promptPlans, { fields: [promptPlanItems.planId], references: [promptPlans.id] }),
}));

/* =========================================================
   MARKETING PLANNER CATALOG  (tables that already exist in MySQL `aarnexai`)
   industries -> business_categories -> services / target_customers
   NOTE: these use BIGINT UNSIGNED ids, exactly like the live database.
========================================================= */

export const industries = mysqlTable(
  'industries',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 180 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', ['ACTIVE', 'INACTIVE']).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('slug').on(table.slug),
  })
);

export const businessCategories = mysqlTable(
  'business_categories',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    industryId: bigint('industry_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => industries.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 180 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', ['ACTIVE', 'INACTIVE']).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    industrySlugUnique: uniqueIndex('uq_business_categories_industry_slug').on(
      table.industryId,
      table.slug
    ),
    industryIdx: index('idx_business_categories_industry_id').on(table.industryId),
  })
);

export const services = mysqlTable(
  'services',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    businessCategoryId: bigint('business_category_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => businessCategories.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    name: varchar('name', { length: 190 }).notNull(),
    slug: varchar('slug', { length: 210 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', ['ACTIVE', 'INACTIVE']).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    categorySlugUnique: uniqueIndex('uq_services_category_slug').on(
      table.businessCategoryId,
      table.slug
    ),
    categoryIdx: index('idx_services_business_category_id').on(table.businessCategoryId),
  })
);

export const targetCustomers = mysqlTable(
  'target_customers',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    businessCategoryId: bigint('business_category_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => businessCategories.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    name: varchar('name', { length: 190 }).notNull(),
    slug: varchar('slug', { length: 210 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', ['ACTIVE', 'INACTIVE']).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    categorySlugUnique: uniqueIndex('uq_target_customers_category_slug').on(
      table.businessCategoryId,
      table.slug
    ),
    categoryIdx: index('idx_target_customers_business_category_id').on(table.businessCategoryId),
  })
);

export const promotionStrategies = mysqlTable(
  'promotion_strategies',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 180 }).notNull(),
    description: text('description').notNull(),
    objective: varchar('objective', { length: 190 }).notNull(),
    strategyOrder: int('strategy_order', { unsigned: true }).notNull().default(1),
    status: mysqlEnum('status', ['ACTIVE', 'INACTIVE']).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('uq_promotion_strategies_slug').on(table.slug),
    orderIdx: index('idx_promotion_strategies_order').on(table.strategyOrder),
  })
);

/**
 * marketing_topics — structure was NOT in your screenshots, so these columns are
 * inferred from the PHP queries and from the v_marketing_topic_library view.
 * Compare with Adminer ("Show structure") and adjust if anything differs.
 */
export const marketingTopics = mysqlTable(
  'marketing_topics',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    businessCategoryId: bigint('business_category_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => businessCategories.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    serviceId: bigint('service_id', { mode: 'number', unsigned: true }).references(
      () => services.id,
      { onDelete: 'set null', onUpdate: 'restrict' }
    ),
    strategyId: bigint('strategy_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => promotionStrategies.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    contentType: mysqlEnum('content_type', ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT', 'REEL', 'STORY'])
      .notNull()
      .default('IMAGE'),
    ctaType: mysqlEnum('cta_type', [
      'CALL',
      'WHATSAPP',
      'MESSAGE',
      'BOOK_NOW',
      'LEARN_MORE',
      'VISIT_STORE',
      'GET_QUOTE',
      'BUY_NOW',
      'WEBSITE',
      'NONE',
    ])
      .notNull()
      .default('WHATSAPP'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    categoryIdx: index('idx_marketing_topics_category').on(table.businessCategoryId),
    serviceIdx: index('idx_marketing_topics_service').on(table.serviceId),
    strategyIdx: index('idx_marketing_topics_strategy').on(table.strategyId),
  })
);

/* =========================================================
   CUSTOMER MARKETING PLANS (30-day calendar)
   customer_id is the id of the `customers` table (BIGINT UNSIGNED) in your DB.
   It is intentionally NOT a Drizzle foreign key to `users` (users.id is INT).
========================================================= */

export const customerServices = mysqlTable(
  'customer_services',
  {
    customerId: bigint('customer_id', { mode: 'number', unsigned: true }).notNull(),
    serviceId: bigint('service_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => services.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.customerId, table.serviceId] }),
    serviceIdx: index('idx_customer_services_service_id').on(table.serviceId),
  })
);

export const customerTargetCustomers = mysqlTable(
  'customer_target_customers',
  {
    customerId: bigint('customer_id', { mode: 'number', unsigned: true }).notNull(),
    targetCustomerId: bigint('target_customer_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => targetCustomers.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.customerId, table.targetCustomerId] }),
    targetIdx: index('idx_customer_target_customers_target_id').on(table.targetCustomerId),
  })
);

export const customerMarketingPlans = mysqlTable(
  'customer_marketing_plans',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    customerId: bigint('customer_id', { mode: 'number', unsigned: true }).notNull(),
    strategyId: bigint('strategy_id', { mode: 'number', unsigned: true }).references(
      () => promotionStrategies.id,
      { onDelete: 'set null', onUpdate: 'restrict' }
    ),
    monthNumber: int('month_number', { unsigned: true }).notNull(),
    planName: varchar('plan_name', { length: 190 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    automationMode: mysqlEnum('automation_mode', ['AUTO', 'MANUAL']).notNull().default('AUTO'),
    marketingGoal: varchar('marketing_goal', { length: 100 }),
    customPrompt: text('custom_prompt'),
    status: mysqlEnum('status', ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'])
      .notNull()
      .default('DRAFT'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    customerMonthUnique: uniqueIndex('uq_cmp_customer_month').on(table.customerId, table.monthNumber),
    strategyIdx: index('idx_cmp_strategy_id').on(table.strategyId),
    datesIdx: index('idx_cmp_start_end').on(table.startDate, table.endDate),
  })
);

export const customerMarketingDays = mysqlTable(
  'customer_marketing_days',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    marketingPlanId: bigint('marketing_plan_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => customerMarketingPlans.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    dayNumber: int('day_number', { unsigned: true }).notNull(),
    topicId: bigint('topic_id', { mode: 'number', unsigned: true }).references(
      () => marketingTopics.id,
      { onDelete: 'set null', onUpdate: 'restrict' }
    ),
    serviceId: bigint('service_id', { mode: 'number', unsigned: true }).references(
      () => services.id,
      { onDelete: 'set null', onUpdate: 'restrict' }
    ),
    strategyId: bigint('strategy_id', { mode: 'number', unsigned: true }).references(
      () => promotionStrategies.id,
      { onDelete: 'set null', onUpdate: 'restrict' }
    ),
    contentType: mysqlEnum('content_type', ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT', 'REEL', 'STORY'])
      .notNull()
      .default('IMAGE'),
    platform: mysqlEnum('platform', [
      'FACEBOOK',
      'INSTAGRAM',
      'THREADS',
      'WHATSAPP',
      'GOOGLE_BUSINESS',
      'MULTI_PLATFORM',
    ])
      .notNull()
      .default('INSTAGRAM'),
    scheduledDate: date('scheduled_date', { mode: 'string' }).notNull(),
    prompt: text('prompt'),
    caption: text('caption'),
    hashtags: text('hashtags'),
    cta: varchar('cta', { length: 190 }),
    imagePrompt: text('image_prompt'),
    status: mysqlEnum('status', [
      'PLANNED',
      'GENERATED',
      'APPROVED',
      'SCHEDULED',
      'PUBLISHED',
      'SKIPPED',
      'FAILED',
    ])
      .notNull()
      .default('PLANNED'),
    publishedAt: datetime('published_at', { mode: 'date' }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    planDayUnique: uniqueIndex('uq_cmd_plan_day').on(table.marketingPlanId, table.dayNumber),
    scheduledIdx: index('idx_cmd_scheduled_date').on(table.scheduledDate),
    statusIdx: index('idx_cmd_status').on(table.status),
    topicIdx: index('idx_cmd_topic_id').on(table.topicId),
    serviceIdx: index('idx_cmd_service_id').on(table.serviceId),
    strategyIdx: index('idx_cmd_strategy_id').on(table.strategyId),
  })
);

/* ---- Read-only views (already exist in MySQL; Drizzle will not create them) ---- */

export const vBusinessCatalog = mysqlView('v_business_catalog', {
  industryId: bigint('industry_id', { mode: 'number', unsigned: true }).notNull(),
  industry: varchar('industry', { length: 150 }).notNull(),
  businessCategoryId: bigint('business_category_id', { mode: 'number', unsigned: true }).notNull(),
  businessCategory: varchar('business_category', { length: 150 }).notNull(),
  serviceId: bigint('service_id', { mode: 'number', unsigned: true }),
  service: varchar('service', { length: 190 }),
  targetCustomerId: bigint('target_customer_id', { mode: 'number', unsigned: true }),
  targetCustomer: varchar('target_customer', { length: 190 }),
}).existing();

export const vMarketingTopicLibrary = mysqlView('v_marketing_topic_library', {
  id: bigint('id', { mode: 'number', unsigned: true }).notNull(),
  industry: varchar('industry', { length: 150 }).notNull(),
  businessCategory: varchar('business_category', { length: 150 }).notNull(),
  service: varchar('service', { length: 190 }),
  strategy: varchar('strategy', { length: 150 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  contentType: mysqlEnum('content_type', ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT', 'REEL', 'STORY']).notNull(),
  ctaType: mysqlEnum('cta_type', [
    'CALL', 'WHATSAPP', 'MESSAGE', 'BOOK_NOW', 'LEARN_MORE', 'VISIT_STORE', 'GET_QUOTE', 'BUY_NOW', 'WEBSITE', 'NONE',
  ]).notNull(),
}).existing();

/* ---- Relations for the planner tables ---- */

export const industriesRelations = relations(industries, ({ many }) => ({
  businessCategories: many(businessCategories),
}));

export const businessCategoriesRelations = relations(businessCategories, ({ one, many }) => ({
  industry: one(industries, { fields: [businessCategories.industryId], references: [industries.id] }),
  services: many(services),
  targetCustomers: many(targetCustomers),
  topics: many(marketingTopics),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  businessCategory: one(businessCategories, {
    fields: [services.businessCategoryId],
    references: [businessCategories.id],
  }),
  topics: many(marketingTopics),
}));

export const targetCustomersRelations = relations(targetCustomers, ({ one }) => ({
  businessCategory: one(businessCategories, {
    fields: [targetCustomers.businessCategoryId],
    references: [businessCategories.id],
  }),
}));

export const promotionStrategiesRelations = relations(promotionStrategies, ({ many }) => ({
  topics: many(marketingTopics),
  plans: many(customerMarketingPlans),
}));

export const marketingTopicsRelations = relations(marketingTopics, ({ one }) => ({
  businessCategory: one(businessCategories, {
    fields: [marketingTopics.businessCategoryId],
    references: [businessCategories.id],
  }),
  service: one(services, { fields: [marketingTopics.serviceId], references: [services.id] }),
  strategy: one(promotionStrategies, {
    fields: [marketingTopics.strategyId],
    references: [promotionStrategies.id],
  }),
}));

export const customerServicesRelations = relations(customerServices, ({ one }) => ({
  service: one(services, { fields: [customerServices.serviceId], references: [services.id] }),
}));

export const customerTargetCustomersRelations = relations(customerTargetCustomers, ({ one }) => ({
  targetCustomer: one(targetCustomers, {
    fields: [customerTargetCustomers.targetCustomerId],
    references: [targetCustomers.id],
  }),
}));

export const customerMarketingPlansRelations = relations(customerMarketingPlans, ({ one, many }) => ({
  strategy: one(promotionStrategies, {
    fields: [customerMarketingPlans.strategyId],
    references: [promotionStrategies.id],
  }),
  days: many(customerMarketingDays),
}));

export const customerMarketingDaysRelations = relations(customerMarketingDays, ({ one }) => ({
  plan: one(customerMarketingPlans, {
    fields: [customerMarketingDays.marketingPlanId],
    references: [customerMarketingPlans.id],
  }),
  topic: one(marketingTopics, { fields: [customerMarketingDays.topicId], references: [marketingTopics.id] }),
  service: one(services, { fields: [customerMarketingDays.serviceId], references: [services.id] }),
  strategy: one(promotionStrategies, {
    fields: [customerMarketingDays.strategyId],
    references: [promotionStrategies.id],
  }),
}));

/* =========================================================
   USERS RELATIONS (defined last so every table exists)
========================================================= */

export const usersRelations = relations(users, ({ many, one }) => ({
  products: many(products),
  subscriptions: many(subscriptions),
  transactions: many(transactions),
  instagramConnections: many(instagramConnections),
  facebookConnections: many(facebookConnections),
  whatsappConnections: many(whatsappConnections),
  whatsappContacts: many(whatsappContacts),
  socialAccounts: many(socialAccounts),
  promptPlan: one(promptPlans, {
    fields: [users.id],
    references: [promptPlans.userId],
  }),
}));