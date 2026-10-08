'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

import { API_URL } from '@/lib/config';

type CatalogKind = 'categories' | 'subcategories' | 'childcategories' | 'presets';
type CatalogRow = Record<string, string | number | boolean | null>;

const config: Record<CatalogKind, { title: string; singular: string }> = {
  categories: { title: 'Categories', singular: 'Category' },
  subcategories: { title: 'Subcategories', singular: 'Subcategory' },
  childcategories: { title: 'Child categories', singular: 'Child category' },
  presets: { title: 'Prompts', singular: 'Prompt' },
};

const fieldClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

async function readJson(response: Response) {
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || 'Could not complete request.');
  return data;
}

export default function CatalogAdminPage({ kind }: { kind: CatalogKind }) {
  const { title, singular } = config[kind];
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [categories, setCategories] = useState<CatalogRow[]>([]);
  const [subcategories, setSubcategories] = useState<CatalogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [icon, setIcon] = useState('');
  const [presetKey, setPresetKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [group, setGroup] = useState('style');
  const [aspectRatio, setAspectRatio] = useState('1:1');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      const response = await fetch(`${API_URL}/${kind}?${params}`, { cache: 'no-store' });
      const data = await readJson(response);
      const responseRows =
        kind === 'categories' ? data.categories :
        kind === 'subcategories' ? data.subcategories :
        kind === 'childcategories' ? data.childCategories :
        data.presets;
      setRows(responseRows);
      setPages(Math.max(1, data.pagination?.pages || 1));
      setTotal(data.pagination?.total || 0);
      if (kind !== 'categories') {
        const categoryResponse = await fetch(`${API_URL}/categories`, { cache: 'no-store' });
        setCategories((await readJson(categoryResponse)).categories);
      }
      if (kind === 'childcategories') {
        const subcategoryResponse = await fetch(`${API_URL}/subcategories`, { cache: 'no-store' });
        setSubcategories((await readJson(subcategoryResponse)).subcategories);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `Could not load ${title.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [kind, page, title]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const endpoint = `/${kind}`;
      let payload: Record<string, unknown> = { name: name.trim() };
      if (kind === 'categories') payload.icon = icon.trim() || null;
      if (kind === 'subcategories') payload.categoryId = Number(parentId);
      if (kind === 'childcategories') payload.subcategoryId = Number(parentId);
      if (kind === 'presets') {
        payload = {
          presetKey: presetKey.trim(),
          name: name.trim(),
          group,
          categoryId: parentId ? Number(parentId) : undefined,
          aspectRatio,
          promptModifier: prompt.trim(),
          requiresOffer: false,
        };
      }
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await readJson(response);
      setName('');
      setIcon('');
      setParentId('');
      setPresetKey('');
      setPrompt('');
      setNotice(`${singular} created.`);
      setPage(1);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : `Could not create ${singular.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  };

  const rowTitle = (row: CatalogRow) => String(row.name || row.title || row.presetKey || 'Untitled');
  const parentLabel = (row: CatalogRow) => {
    if (kind === 'subcategories') {
      return categories.find((item) => String(item.id) === String(row.categoryId))?.name;
    }
    if (kind === 'childcategories') {
      return subcategories.find((item) => String(item.id) === String(row.subcategoryId))?.name;
    }
    if (kind === 'presets') {
      return categories.find((item) => String(item.id) === String(row.categoryId))?.name || 'Universal prompt';
    }
    return '';
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">Manage {title.toLowerCase()} independently. {total} total.</p>
      </div>
      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <form onSubmit={create} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Add {singular}</h2>
        {kind === 'presets' && (
          <>
            <label className="block text-sm font-medium text-slate-700">Prompt key<input required className={`${fieldClass} mt-1`} value={presetKey} onChange={(event) => setPresetKey(event.target.value)} /></label>
            <label className="block text-sm font-medium text-slate-700">Prompt group<select className={`${fieldClass} mt-1`} value={group} onChange={(event) => setGroup(event.target.value)}><option value="style">Style</option><option value="creative_type">Creative type</option></select></label>
          </>
        )}
        <label className="block text-sm font-medium text-slate-700">Name<input required className={`${fieldClass} mt-1`} value={name} onChange={(event) => setName(event.target.value)} /></label>
        {kind === 'categories' && <label className="block text-sm font-medium text-slate-700">Icon (optional)<input className={`${fieldClass} mt-1`} value={icon} onChange={(event) => setIcon(event.target.value)} /></label>}
        {(kind === 'subcategories' || kind === 'childcategories' || kind === 'presets') && (
          <label className="block text-sm font-medium text-slate-700">
            {kind === 'childcategories' ? 'Subcategory' : 'Category'}
            <select required={kind !== 'presets'} className={`${fieldClass} mt-1`} value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {kind === 'presets' && <option value="">Universal prompt</option>}
              <option value="" disabled={kind !== 'presets'}>{kind === 'childcategories' ? 'Select a subcategory' : 'Select a category'}</option>
              {(kind === 'childcategories' ? subcategories : categories).map((item) => (
                <option key={String(item.id)} value={String(item.id)}>{String(item.name)}</option>
              ))}
            </select>
          </label>
        )}
        {kind === 'presets' && (
          <>
            <label className="block text-sm font-medium text-slate-700">Aspect ratio<input className={`${fieldClass} mt-1`} value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} /></label>
            <label className="block text-sm font-medium text-slate-700">Prompt instructions<textarea required rows={5} className={`${fieldClass} mt-1`} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          </>
        )}
        <button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : `Add ${singular}`}</button>
      </form>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="divide-y">
          {loading ? <p className="px-5 py-8 text-sm text-slate-500">Loading…</p> : rows.map((row) => (
            <div key={String(row.id)} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <strong className="text-sm text-slate-900">{rowTitle(row)}</strong>
                <p className="mt-1 text-xs text-slate-500">
                  {parentLabel(row)}{kind === 'presets' ? ` · ${String(row.group)} · ${String(row.aspectRatio)}` : ''}
                </p>
              </div>
              <span className="text-xs text-slate-400">ID {String(row.id)}</span>
            </div>
          ))}
          {!loading && rows.length === 0 && <p className="px-5 py-8 text-sm text-slate-500">No {title.toLowerCase()} found.</p>}
        </div>
        <div className="flex items-center justify-between border-t bg-slate-50 px-5 py-3 text-sm text-slate-600">
          <span>Page {page} of {pages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} className="rounded-md border bg-white px-3 py-1.5 disabled:opacity-40">Previous</button>
            <button disabled={page >= pages || loading} onClick={() => setPage((value) => value + 1)} className="rounded-md border bg-white px-3 py-1.5 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
