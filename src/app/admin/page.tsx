'use client';

import { useEffect, useState } from 'react';
import { NEXT_PUBLIC_BASE_PATH, API_URL } from '@/lib/config';

interface Counts {
  categories: number;
  subcategories: number;
  presets: number;
}

interface Overview {
  vendors: number;
  activeVendors: number;
  suspendedVendors: number;
  products: number;
  banners: number;
  subscriptions: number;
  paidTransactions: number;
  grossRevenuePaise: number;
}

type CountKey = keyof Counts;

function CategoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

function SubcategoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4v16M7 4h10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H7M7 15h6a2 2 0 0 1 2 2v3" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className={spinning ? 'animate-spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" />
    </svg>
  );
}

const INVENTORY: {
  key: CountKey;
  label: string;
  detail: string;
  tab: string;
  icon: React.ReactNode;
  accent: string;
}[] = [
  {
    key: 'categories',
    label: 'Categories',
    detail: 'Top-level business types',
    tab: 'category',
    icon: <CategoryIcon />,
    accent: 'bg-emerald-50 text-emerald-700',
  },
  {
    key: 'subcategories',
    label: 'Subcategories',
    detail: 'Specialties under each category',
    tab: 'subcategory',
    icon: <SubcategoryIcon />,
    accent: 'bg-sky-50 text-sky-700',
  },
  {
    key: 'presets',
    label: 'Creative prompts',
    detail: 'Styles and creative formats',
    tab: 'preset',
    icon: <PromptIcon />,
    accent: 'bg-amber-50 text-amber-700',
  },
];

const AdminDashboardPage: React.FC = () => {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let isCurrent = true;

    async function loadOverview() {
      setLoading(true);
      setLoadError('');

      try {
        const responses = await Promise.all([
          fetch(`${API_URL}/categories`, { cache: 'no-store' }),
          fetch(`${API_URL}/subcategories`, { cache: 'no-store' }),
          fetch(`${API_URL}/presets`, { cache: 'no-store' }),
          fetch(`${API_URL}/admin/overview`, { cache: 'no-store', credentials: 'include' }),
        ]);

        if (responses.some((response) => !response.ok)) {
          throw new Error('Could not load all dashboard data. Refresh to try again.');
        }

        const [categoryData, subcategoryData, presetData, overviewData] = await Promise.all(
          responses.map((response) => response.json())
        );

        if (!categoryData.success || !subcategoryData.success || !presetData.success || !overviewData.success) {
          throw new Error('Could not load all dashboard data. Refresh to try again.');
        }

        if (isCurrent) {
          setCounts({
            categories: categoryData.categories?.length ?? 0,
            subcategories: subcategoryData.subcategories?.length ?? 0,
            presets: presetData.presets?.length ?? 0,
          });
          setOverview(overviewData.overview);
          setUpdatedAt(new Date());
        }
      } catch (error) {
        if (isCurrent) {
          setLoadError(error instanceof Error ? error.message : 'Dashboard data failed to load.');
        }
      } finally {
        if (isCurrent) setLoading(false);
      }
    }

    void loadOverview();
    return () => {
      isCurrent = false;
    };
  }, [refreshKey]);

  const inventoryRows = INVENTORY.map((item) => {
    const configured = counts ? counts[item.key] > 0 : false;
    const href = `${NEXT_PUBLIC_BASE_PATH}/admin/manage?tab=${item.tab}`;

    return (
      <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-100 py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_90px_116px]">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg [&>svg]:h-5 [&>svg]:w-5 ${item.accent}`}>
            {item.icon}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{item.label}</span>
            <span className="mt-0.5 block truncate text-xs text-slate-500">{item.detail}</span>
          </span>
        </div>
        <div className="text-right sm:text-left">
          <span className="block text-xl font-semibold tabular-nums text-slate-900">
            {loading ? '—' : counts?.[item.key] ?? '—'}
          </span>
          <span className={`mt-0.5 inline-flex items-center gap-1.5 text-xs font-medium ${loadError ? 'text-rose-700' : configured ? 'text-emerald-700' : 'text-amber-700'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${loadError ? 'bg-rose-500' : configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {loadError ? 'Unavailable' : loading ? 'Loading' : configured ? 'Configured' : 'Needs setup'}
          </span>
        </div>
        <a
          href={href}
          className="col-span-2 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 sm:col-span-1"
        >
          Manage
          <span className="[&>svg]:h-3.5 [&>svg]:w-3.5"><ArrowRightIcon /></span>
        </a>
      </div>
    );
  });

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      <section className="flex flex-col justify-between gap-5 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-emerald-800">Admin / Overview</p>
          <h1 className="text-3xl font-semibold text-slate-950">Control room</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Manage the content configuration that powers product categories and ad creative generation.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500" aria-live="polite">
            {loadError ? 'Data needs attention' : updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Loading overview'}
          </span>
          <button
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            disabled={loading}
            aria-label="Refresh dashboard data"
            title="Refresh dashboard data"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 [&>svg]:h-4 [&>svg]:w-4"
          >
            <RefreshIcon spinning={loading} />
          </button>
        </div>
      </section>

      {loadError && (
        <div role="alert" className="flex flex-col justify-between gap-3 border-l-4 border-rose-500 bg-rose-50 px-4 py-3 sm:flex-row sm:items-center">
          <p className="text-sm text-rose-800">{loadError}</p>
          <button
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            className="self-start text-sm font-semibold text-rose-800 underline underline-offset-4 sm:self-auto"
          >
            Try again
          </button>
        </div>
      )}

      <section aria-labelledby="inventory-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="inventory-title" className="text-lg font-semibold text-slate-950">Configuration inventory</h2>
            <p className="mt-1 text-sm text-slate-500">Live totals from the admin content APIs.</p>
          </div>
          <span className="text-xs font-medium text-slate-500">{loading ? 'Refreshing' : loadError ? 'Refresh required' : 'Live data'}</span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {INVENTORY.map((item) => (
            <div key={item.key} className="rounded-lg border border-slate-200 bg-white px-4 py-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600">{item.label}</span>
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg [&>svg]:h-[18px] [&>svg]:w-[18px] ${item.accent}`}>
                  {item.icon}
                </span>
              </div>
              <p className="mt-4 text-3xl font-semibold tabular-nums text-slate-950">
                {loading ? '—' : counts?.[item.key] ?? '—'}
              </p>
              <p className="mt-1 text-xs text-slate-500">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="operations-title">
        <div className="mb-4">
          <h2 id="operations-title" className="text-lg font-semibold text-slate-950">Marketplace operations</h2>
          <p className="mt-1 text-sm text-slate-500">Live account, catalog and payment totals from the backend.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: 'Vendors', value: overview?.vendors, detail: `${overview?.activeVendors ?? '—'} active · ${overview?.suspendedVendors ?? '—'} suspended` },
            { label: 'Products', value: overview?.products, detail: 'Across all vendor accounts' },
            { label: 'Banners', value: overview?.banners, detail: 'Generated marketplace content' },
            { label: 'Subscriptions', value: overview?.subscriptions, detail: 'Current and past plan records' },
            { label: 'Paid revenue', value: overview ? `₹${(overview.grossRevenuePaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—', detail: `${overview?.paidTransactions ?? '—'} successful transactions` },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-medium text-slate-500">{item.label}</p>
              <p className="mt-3 text-2xl font-semibold tabular-nums text-slate-950">{loading ? '—' : item.value ?? '—'}</p>
              <p className="mt-1 text-xs text-slate-500">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-2 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 py-4">
            <div>
              <h2 className="text-base font-semibold text-slate-950">Manage configuration</h2>
              <p className="mt-1 text-sm text-slate-500">Open a workspace to add and review its records.</p>
            </div>
            <span className="text-xs text-slate-500">{INVENTORY.length} workspaces</span>
          </div>
          <div>{inventoryRows}</div>
        </div>

        <aside className="rounded-lg bg-slate-950 p-5 text-white sm:p-6">
          <p className="text-xs font-semibold uppercase text-emerald-300">Workflow</p>
          <h2 className="mt-2 text-lg font-semibold">Creative setup</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Keep these three layers aligned so each business can get relevant ad concepts.
          </p>
          <ol className="mt-6 space-y-0">
            {INVENTORY.map((item, index) => (
              <li key={item.key} className="relative flex gap-3 pb-5 last:pb-0">
                {index < INVENTORY.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-16px)] w-px bg-slate-700" />}
                <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-700 bg-slate-900 text-xs font-semibold text-emerald-300">
                  {index + 1}
                </span>
                <span className="pt-1">
                  <span className="block text-sm font-medium text-white">{item.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-400">{item.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </section>
    </div>
  );
};

export default AdminDashboardPage;