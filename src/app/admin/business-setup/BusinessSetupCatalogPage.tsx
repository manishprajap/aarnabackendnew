'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { API_URL } from '@/lib/config';

type CatalogType = 'industry' | 'businessCategory' | 'service' | 'targetCustomer' | 'strategy';
type CatalogItem = {
  id: number;
  name: string;
  industryId?: number;
  businessCategoryId?: number;
  objective?: string;
  description?: string | null;
  strategyOrder?: number;
};
type Catalog = {
  industries: CatalogItem[];
  businessCategories: CatalogItem[];
  services: CatalogItem[];
  targetCustomers: CatalogItem[];
  strategies: CatalogItem[];
};

const EMPTY_CATALOG: Catalog = {
  industries: [],
  businessCategories: [],
  services: [],
  targetCustomers: [],
  strategies: [],
};

const SECTIONS: { type: CatalogType; label: string; singular: string; plural: keyof Catalog }[] = [
  { type: 'industry', label: 'Industries', singular: 'Industry', plural: 'industries' },
  { type: 'businessCategory', label: 'Business categories', singular: 'Business category', plural: 'businessCategories' },
  { type: 'service', label: 'Products / services', singular: 'Product / service', plural: 'services' },
  { type: 'targetCustomer', label: 'Target customers', singular: 'Target customer', plural: 'targetCustomers' },
  { type: 'strategy', label: 'Marketing strategies', singular: 'Marketing strategy', plural: 'strategies' },
];

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

async function responseJson(response: Response) {
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || 'Could not complete the request.');
  }
  return data;
}

export default function BusinessSetupCatalogPage() {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [selectedType, setSelectedType] = useState<CatalogType>('industry');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objective, setObjective] = useState('');
  const [parentId, setParentId] = useState('');
  const [strategyOrder, setStrategyOrder] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/admin/business-setup-catalog`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await responseJson(response);
      setCatalog(data.catalog);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load setup options.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadCatalog(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalog]);

  const selectedSection = SECTIONS.find((section) => section.type === selectedType)!;
  const requiresParent = selectedType === 'businessCategory' || selectedType === 'service' || selectedType === 'targetCustomer';
  const parentItems = useMemo(() => {
    if (selectedType === 'businessCategory') return catalog.industries;
    if (selectedType === 'service' || selectedType === 'targetCustomer') return catalog.businessCategories;
    return [];
  }, [catalog, selectedType]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload: Record<string, unknown> = {
        type: selectedType,
        name: name.trim(),
        description: description.trim() || undefined,
      };
      if (selectedType === 'businessCategory') payload.industryId = Number(parentId);
      if (selectedType === 'service' || selectedType === 'targetCustomer') {
        payload.businessCategoryId = Number(parentId);
      }
      if (selectedType === 'strategy') {
        payload.objective = objective.trim();
        payload.strategyOrder = Number(strategyOrder);
      }

      const response = await fetch(`${API_URL}/admin/business-setup-catalog`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await responseJson(response);
      setName('');
      setDescription('');
      setObjective('');
      setParentId('');
      setStrategyOrder('1');
      setNotice(`${selectedSection.singular} added.`);
      await loadCatalog();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not add this setup option.');
    } finally {
      setSaving(false);
    }
  };

  const parentName = (item: CatalogItem) => {
    if (selectedType === 'businessCategory') {
      return catalog.industries.find((parent) => parent.id === item.industryId)?.name ?? 'Industry unavailable';
    }
    if (selectedType === 'service' || selectedType === 'targetCustomer') {
      return catalog.businessCategories.find((parent) => parent.id === item.businessCategoryId)?.name
        ?? 'Business category unavailable';
    }
    if (selectedType === 'strategy') return item.objective || 'Marketing objective';
    return '';
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Admin / Configuration</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">Business setup options</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Manage the same industry, business category, products/services, target customers and promotion strategies users choose during setup.
        </p>
      </header>

      {error && <div role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {SECTIONS.map((section) => (
          <button
            key={section.type}
            type="button"
            onClick={() => {
              setSelectedType(section.type);
              setParentId('');
              setError('');
              setNotice('');
            }}
            className={`rounded-xl border p-4 text-left transition ${
              selectedType === section.type
                ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100'
                : 'border-slate-200 bg-white hover:border-indigo-300'
            }`}
          >
            <span className="block text-sm font-semibold text-slate-800">{section.label}</span>
            <span className="mt-2 block text-2xl font-bold tabular-nums text-slate-950">
              {loading ? '—' : catalog[section.plural].length}
            </span>
            <span className="mt-1 block text-xs text-slate-500">active options</span>
          </button>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
        <form onSubmit={create} className="h-fit space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Add {selectedSection.singular}</h2>
            <p className="mt-1 text-sm text-slate-500">New active options will appear in Business Setup.</p>
          </div>

          {requiresParent && (
            <label className="block text-sm font-medium text-slate-700">
              {selectedType === 'businessCategory' ? 'Industry' : 'Business category'}
              <select
                required
                className={inputClass}
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
              >
                <option value="">
                  {parentItems.length
                    ? `Select ${selectedType === 'businessCategory' ? 'an industry' : 'a business category'}`
                    : `Add ${selectedType === 'businessCategory' ? 'an industry' : 'a business category'} first`}
                </option>
                {parentItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="block text-sm font-medium text-slate-700">
            Name
            <input required minLength={2} maxLength={190} className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          {selectedType === 'strategy' && (
            <>
              <label className="block text-sm font-medium text-slate-700">
                Objective
                <input required maxLength={190} className={inputClass} value={objective} onChange={(event) => setObjective(event.target.value)} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Display order
                <input type="number" min="0" step="1" className={inputClass} value={strategyOrder} onChange={(event) => setStrategyOrder(event.target.value)} />
              </label>
            </>
          )}

          <label className="block text-sm font-medium text-slate-700">
            Description {selectedType === 'strategy' ? '' : '(optional)'}
            <textarea
              required={selectedType === 'strategy'}
              rows={4}
              maxLength={5000}
              className={inputClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <button
            disabled={saving || loading || (requiresParent && (!parentItems.length || !parentId))}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add option'}
          </button>
        </form>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold text-slate-950">{selectedSection.label}</h2>
            <p className="mt-1 text-sm text-slate-500">Options currently shown to business setup users.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {loading ? (
              <p className="px-5 py-8 text-sm text-slate-500">Loading setup options…</p>
            ) : catalog[selectedSection.plural].length ? (
              catalog[selectedSection.plural].map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{parentName(item)}</p>
                    {item.description && <p className="mt-1 max-w-2xl text-xs text-slate-500">{item.description}</p>}
                  </div>
                  <span className="text-xs text-slate-400">ID {item.id}</span>
                </div>
              ))
            ) : (
              <p className="px-5 py-8 text-sm text-slate-500">No active options in this section yet.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
