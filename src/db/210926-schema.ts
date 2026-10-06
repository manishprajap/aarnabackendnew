import {
  mysqlTable,
  varchar,
  text,
  int,
  bigint,
  timestamp,
  datetime,
  mysqlEnum,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';

import { relations, sql } from 'drizzle-orm';

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 191 }),
  mobile: varchar('mobile', { length: 20 }).unique(),
  email: varchar('email', { length: 191 }).unique(),
  password: varchar('password', { length: 255 }),
  plan: varchar('plan', { length: 50 }),
  image: int('image'),
  credits: int('credits'),
  category: varchar('category', { length: 100 }),
categoryId: int('category_id').references(() => categories.id),
  city: varchar('city', { length: 100 }),
  website: varchar('website', { length: 255 }),
  logo: varchar('logo', { length: 255 }),
  language: varchar('language', { length: 50 }),
  googleConnected: boolean('google_connected'),
  facebookConnected: boolean('facebook_connected'),
  instagramConnected: boolean('instagram_connected'),
  whatsappConnected: boolean('whatsapp_connected'),
  deviceId: varchar('device_id', { length: 191 }),
  deviceType: varchar('device_type', { length: 50 }),
  deviceName: varchar('device_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
});

export const otps = mysqlTable(
  'otps',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),

    mobile: varchar('mobile', { length: 15 }).notNull(),

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

// Added `durationDays` so the subscription API knows how long a purchased
// plan period should last (used to compute a subscription's `endDate`).
export const plans = mysqlTable('plans', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  price: int('price').notNull(),
  posters: int('posters').notNull(),
  features: text('features'),
  durationDays: int('duration_days').notNull().default(30),
});


export const instagramConnections = mysqlTable(
  'instagram_connections',
  {
    id: int('id').autoincrement().primaryKey(),

    userId: int('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    instagramUserId: varchar('instagram_user_id', {
      length: 100,
    }).notNull(),

    instagramUsername: varchar(
      'instagram_username',
      {
        length: 255,
      }
    ),

    instagramName: varchar(
      'instagram_name',
      {
        length: 255,
      }
    ),

    instagramProfilePicture: text(
      'instagram_profile_picture'
    ),

    accessToken: text(
      'access_token'
    ).notNull(),

    tokenExpiresAt: timestamp(
      'token_expires_at'
    ),

    status: mysqlEnum('status', [
      'active',
      'expired',
      'revoked',
    ])
      .default('active')
      .notNull(),

    createdAt: timestamp(
      'created_at'
    )
      .defaultNow()
      .notNull(),

    updatedAt: timestamp(
      'updated_at'
    )
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },

  (table) => ({
    instagramUserUnique: uniqueIndex(
      'uq_instagram_user_id'
    ).on(
      table.instagramUserId
    ),

    userInstagramUnique: uniqueIndex(
      'uq_user_instagram'
    ).on(
      table.userId
    ),

    userIdIndex: index(
      'idx_instagram_connections_user_id'
    ).on(
      table.userId
    ),
  })
);

export const facebookConnections = mysqlTable(
  'facebook_connections',
  {
    id: int('id').autoincrement().primaryKey(),

    userId: int('user_id').notNull(),

    pageId: varchar('page_id', {
      length: 100,
    }).notNull(),

    pageName: varchar('page_name', {
      length: 255,
    }),

    pageProfilePicture: text(
      'page_profile_picture'
    ),

    /**
     * IMPORTANT:
     * This stores the encrypted Facebook Page access token.
     */
    accessToken: text(
      'access_token'
    ).notNull(),

    status: varchar('status', {
      length: 30,
    })
      .notNull()
      .default('active'),

    connectedAt: datetime(
      'connected_at',
      {
        mode: 'date',
      }
    )
      .notNull()
      .default(new Date()),

    lastVerifiedAt: datetime(
      'last_verified_at',
      {
        mode: 'date',
      }
    ),

    tokenExpiresAt: datetime(
      'token_expires_at',
      {
        mode: 'date',
      }
    ),

    lastPublishAt: datetime(
      'last_publish_at',
      {
        mode: 'date',
      }
    ),

    lastError: text(
      'last_error'
    ),

    createdAt: timestamp(
      'created_at'
    )
      .notNull()
      .defaultNow(),

    updatedAt: timestamp(
      'updated_at'
    )
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => ({
    userUnique: uniqueIndex(
      'facebook_connections_user_unique'
    ).on(table.userId),

    pageIndex: index(
      'facebook_connections_page_idx'
    ).on(table.pageId),

    statusIndex: index(
      'facebook_connections_status_idx'
    ).on(table.status),
  })
);

/**
 * OAuth states.
 *
 * Never put the user ID directly inside a trusted client-controlled
 * OAuth state payload.
 */
export const facebookOAuthStates = mysqlTable(
  'facebook_oauth_states',
  {
    id: int('id').autoincrement().primaryKey(),

    stateHash: varchar('state_hash', {
      length: 128,
    }).notNull(),

    userId: int('user_id').notNull(),

    expiresAt: datetime(
      'expires_at',
      {
        mode: 'date',
      }
    ).notNull(),

    usedAt: datetime(
      'used_at',
      {
        mode: 'date',
      }
    ),

    createdAt: timestamp(
      'created_at'
    )
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    stateUnique: uniqueIndex(
      'facebook_oauth_state_unique'
    ).on(table.stateHash),

    userIndex: index(
      'facebook_oauth_user_idx'
    ).on(table.userId),

    expiryIndex: index(
      'facebook_oauth_expiry_idx'
    ).on(table.expiresAt),
  })
);

/* =========================================================
   WHATSAPP — Embedded Signup connection (one per seller) +
   the contact list that seller broadcasts banners to.
========================================================= */

export const whatsappConnections = mysqlTable(
  'whatsapp_connections',
  {
    id: int('id').autoincrement().primaryKey(),

    userId: int('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // WhatsApp Business Account ID (the container Meta
    // assigns when the seller completes Embedded Signup)
    wabaId: varchar('waba_id', { length: 100 }).notNull(),

    // The specific phone number registered under that WABA —
    // this is what you send messages FROM.
    phoneNumberId: varchar('phone_number_id', {
      length: 100,
    }).notNull(),

    businessPhoneNumber: varchar(
      'business_phone_number',
      { length: 32 }
    ),

    businessName: varchar('business_name', { length: 255 }),

    // System user / long-lived access token for this WABA.
    accessToken: text('access_token').notNull(),

    tokenExpiresAt: timestamp('token_expires_at'),

    status: mysqlEnum('status', [
      'active',
      'expired',
      'revoked',
    ])
      .default('active')
      .notNull(),

    createdAt: timestamp('created_at')
      .defaultNow()
      .notNull(),

    updatedAt: timestamp('updated_at')
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (table) => ({
    userWhatsappUnique: uniqueIndex(
      'uq_user_whatsapp'
    ).on(table.userId),

    userIdIndex: index(
      'idx_whatsapp_connections_user_id'
    ).on(table.userId),
  })
);

// Contacts a seller wants to broadcast banners to.
export const whatsappContacts = mysqlTable(
  'whatsapp_contacts',
  {
    id: int('id').autoincrement().primaryKey(),

    userId: int('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    name: varchar('name', { length: 191 }),

    // Store in E.164 format, e.g. 91XXXXXXXXXX (no leading +)
    phoneNumber: varchar('phone_number', {
      length: 20,
    }).notNull(),

    isActive: boolean('is_active').default(true).notNull(),

    createdAt: timestamp('created_at')
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdIndex: index(
      'idx_whatsapp_contacts_user_id'
    ).on(table.userId),

    userPhoneUnique: uniqueIndex(
      'uq_user_phone'
    ).on(table.userId, table.phoneNumber),
  })
);

export const socialAccounts = mysqlTable(
  'social_accounts',
  {
    id: int('id').autoincrement().primaryKey(),
    userId: int('user_id').notNull().references(() => users.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    }),
    provider: varchar('provider', { length: 40 }).notNull(),
    providerAccountId: varchar('provider_account_id', { length: 160 }),
    accountName: varchar('account_name', { length: 255 }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
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



export const usersRelations = relations(
  users,
  ({ many }) => ({
    products: many(products),

    subscriptions: many(subscriptions),

    transactions: many(transactions),

    instagramConnections: many(
      instagramConnections
    ),

    facebookConnections: many(
      facebookConnections
    ),

    whatsappConnections: many(
      whatsappConnections
    ),

    whatsappContacts: many(
      whatsappContacts
    ),
  })
);

export const productsRelations = relations(products, ({ one, many }) => ({
  user: one(users, {
    fields: [products.userId],
    references: [users.id],
  }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  subcategory: one(subcategories, {
    fields: [products.subcategoryId],
    references: [subcategories.id],
  }),
  banners: many(banners),
  adCreatives: many(adCreatives),
}));

export const bannersRelations = relations(banners, ({ one }) => ({
  product: one(products, {
    fields: [banners.productId],
    references: [products.id],
  }),
}));

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

export const adPresetsRelations = relations(adPresets, ({ one, many }) => ({
  category: one(categories, {
    fields: [adPresets.categoryId],
    references: [categories.id],
  }),
  creatives: many(adCreatives),
}));

export const instagramConnectionsRelations =
  relations(
    instagramConnections,
    ({ one }) => ({
      user: one(users, {
        fields: [
          instagramConnections.userId,
        ],
        references: [users.id],
      }),
    })
  );

export const facebookConnectionsRelations = relations(
  facebookConnections,
  ({ one }) => ({
    user: one(users, {
      fields: [facebookConnections.userId],
      references: [users.id],
    }),
  })
);

export const whatsappConnectionsRelations = relations(
  whatsappConnections,
  ({ one }) => ({
    user: one(users, {
      fields: [whatsappConnections.userId],
      references: [users.id],
    }),
  })
);

export const whatsappContactsRelations = relations(
  whatsappContacts,
  ({ one }) => ({
    user: one(users, {
      fields: [whatsappContacts.userId],
      references: [users.id],
    }),
  })
);

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

export const adCreativesRelations = relations(adCreatives, ({ one }) => ({
  product: one(products, {
    fields: [adCreatives.productId],
    references: [products.id],
  }),
  preset: one(adPresets, {
    fields: [adCreatives.presetId],
    references: [adPresets.id],
  }),
}));

export const childCategories = mysqlTable('child_categories', {
  id: int('id').autoincrement().primaryKey(),
  subcategoryId: int('subcategory_id').notNull().references(() => subcategories.id),
  name: varchar('name', { length: 100 }).notNull(),
  sortOrder: int('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

export const childCategoriesRelations = relations(childCategories, ({ one }) => ({
  subcategory: one(subcategories, {
    fields: [childCategories.subcategoryId],
    references: [subcategories.id],
  }),
}));

// ==================================================
// SUBSCRIPTIONS — one row per plan period a user has purchased/is on.
// A user's currently active period is the most recent row with
// status = 'active' and endDate in the future.
// ==================================================

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

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
  plan: one(plans, {
    fields: [subscriptions.planId],
    references: [plans.id],
  }),
  transactions: many(transactions),
}));

// ==================================================
// TRANSACTIONS — one row per Razorpay order attempt (created, paid, or
// failed). This is the payment audit log; `subscriptions` tracks the
// resulting plan period, not the payment itself.
// ==================================================

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

    amount: int('amount').notNull(), // stored in paise (₹1 = 100)
    currency: varchar('currency', { length: 10 }).notNull().default('INR'),

    status: mysqlEnum('status', ['created', 'paid', 'failed']).default('created').notNull(),
    method: varchar('method', { length: 50 }), // card, upi, netbanking, etc. (set on success)
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

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user: one(users, {
    fields: [transactions.userId],
    references: [users.id],
  }),
  plan: one(plans, {
    fields: [transactions.planId],
    references: [plans.id],
  }),
  subscription: one(subscriptions, {
    fields: [transactions.subscriptionId],
    references: [subscriptions.id],
  }),
}));
