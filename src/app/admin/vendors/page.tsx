'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

import { API_URL } from '@/lib/config';

type Vendor = {
  id: number;
  name: string | null;
  mobile: string | null;
  email: string | null;
  businessName: string | null;
  plan: string | null;
  credits: number | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  createdAt: string | null;
};

type VendorStatus = 'all' | Vendor['status'];

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const VendorsPage = () => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<VendorStatus>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadVendors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        status,
      });
      if (search) params.set('q', search);

      const response = await fetch(`${API_URL}/admin/vendors?${params}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Could not load vendors.');
      }
      setVendors(data.vendors);
      setTotal(data.pagination.total);
      setPages(Math.max(1, data.pagination.pages));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load vendors.');
    } finally {
      setLoading(false);
    }
  }, [page, refreshKey, search, status]);

  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);

  const createVendor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/admin/vendors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, mobile, email, businessName }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Could not create vendor.');
      }
      setNotice(data.message);
      setName('');
      setMobile('');
      setEmail('');
      setBusinessName('');
      setCreateOpen(false);
      setPage(1);
      setSearch('');
      setStatus('all');
      setRefreshKey((value) => value + 1);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create vendor.');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (vendor: Vendor) => {
    const nextStatus = vendor.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const action = nextStatus === 'SUSPENDED' ? 'suspend' : 'activate';
    if (!window.confirm(`Are you sure you want to ${action} ${vendor.name || vendor.mobile}?`)) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/admin/vendors/${vendor.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Could not ${action} vendor.`);
      }
      setNotice(`Vendor ${nextStatus === 'ACTIVE' ? 'activated' : 'suspended'} successfully.`);
      setRefreshKey((value) => value + 1);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : `Could not ${action} vendor.`);
    } finally {
      setSaving(false);
    }
  };

  const saveVendor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingVendor) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/admin/vendors/${editingVendor.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: editingVendor.name,
          email: editingVendor.email || '',
          businessName: editingVendor.businessName || '',
          credits: Number(editingVendor.credits) || 0,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Could not save vendor changes.');
      }
      setEditingVendor(null);
      setNotice('Vendor details updated successfully.');
      setRefreshKey((value) => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save vendor changes.');
    } finally {
      setSaving(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSearch(query.trim());
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <section className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-indigo-700">Admin / Marketplace</p>
          <h1 className="text-3xl font-semibold text-slate-950">Vendor management</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Create and manage vendor accounts, review account status and control access to the platform.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError('');
            setCreateOpen(true);
          }}
          className="inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700"
        >
          Add vendor
        </button>
      </section>

      {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}

      {createOpen && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Create vendor account</h2>
              <p className="mt-1 text-sm text-slate-500">Vendors sign in with their registered mobile number and OTP.</p>
            </div>
            <button type="button" onClick={() => setCreateOpen(false)} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" aria-label="Close form">Close</button>
          </div>
          <form onSubmit={createVendor} className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Vendor name *
              <input className={inputClass} required minLength={2} maxLength={191} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Mobile number *
              <input className={inputClass} required inputMode="numeric" pattern="[6-9][0-9]{9}" maxLength={10} value={mobile} onChange={(event) => setMobile(event.target.value.replace(/\D/g, '').slice(0, 10))} autoComplete="tel-national" />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Email
              <input className={inputClass} type="email" maxLength={191} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Business name
              <input className={inputClass} maxLength={190} value={businessName} onChange={(event) => setBusinessName(event.target.value)} autoComplete="organization" />
            </label>
            <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
              <button type="button" onClick={() => setCreateOpen(false)} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={saving} className="min-h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{saving ? 'Creating…' : 'Create vendor'}</button>
            </div>
          </form>
        </section>
      )}

      {editingVendor && (
        <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Edit vendor #{editingVendor.id}</h2>
              <p className="mt-1 text-sm text-slate-500">Mobile number is the vendor&apos;s OTP login identifier and cannot be changed here.</p>
            </div>
            <button type="button" onClick={() => setEditingVendor(null)} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-white" aria-label="Close edit form">Close</button>
          </div>
          <form onSubmit={saveVendor} className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Vendor name
              <input className={inputClass} required minLength={2} maxLength={191} value={editingVendor.name || ''} onChange={(event) => setEditingVendor({ ...editingVendor, name: event.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Business name
              <input className={inputClass} maxLength={190} value={editingVendor.businessName || ''} onChange={(event) => setEditingVendor({ ...editingVendor, businessName: event.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Email
              <input className={inputClass} type="email" maxLength={191} value={editingVendor.email || ''} onChange={(event) => setEditingVendor({ ...editingVendor, email: event.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-slate-700">
              Credits
              <input className={inputClass} type="number" min={0} max={1000000} step={1} value={editingVendor.credits ?? 0} onChange={(event) => setEditingVendor({ ...editingVendor, credits: Number(event.target.value) })} />
            </label>
            <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
              <button type="button" onClick={() => setEditingVendor(null)} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-white">Cancel</button>
              <button type="submit" disabled={saving} className="min-h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Total vendors', value: total, detail: 'Matching current filters' },
          { label: 'Current page', value: vendors.length, detail: 'Vendor accounts shown' },
          { label: 'Page', value: `${page} / ${pages}`, detail: 'Use pagination to browse' },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-sm font-medium text-slate-500">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{loading ? '—' : stat.value}</p>
            <p className="mt-1 text-xs text-slate-500">{stat.detail}</p>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <form onSubmit={submitSearch} className="flex min-w-0 flex-1 gap-2">
            <input className={`${inputClass} max-w-lg`} placeholder="Search name, phone, email or business" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Search</button>
          </form>
          <select
            aria-label="Filter vendors by status"
            className={`${inputClass} sm:w-44`}
            value={status}
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value as VendorStatus);
            }}
          >
            <option value="all">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Vendor</th>
                <th className="px-4 py-3 font-semibold">Business</th>
                <th className="px-4 py-3 font-semibold">Plan / credits</th>
                <th className="px-4 py-3 font-semibold">Joined</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={6}>Loading vendor accounts…</td></tr>}
              {!loading && vendors.length === 0 && <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={6}>No vendors match these filters.</td></tr>}
              {!loading && vendors.map((vendor) => (
                <tr key={vendor.id} className="hover:bg-slate-50/70">
                  <td className="px-4 py-3.5">
                    <p className="font-semibold text-slate-900">{vendor.name || 'Unnamed vendor'}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{vendor.mobile || 'No mobile'}{vendor.email ? ` · ${vendor.email}` : ''}</p>
                    <p className="mt-1 text-[11px] text-slate-400">ID #{vendor.id}</p>
                  </td>
                  <td className="px-4 py-3.5 text-slate-700">{vendor.businessName || '—'}</td>
                  <td className="px-4 py-3.5">
                    <span className="block capitalize text-slate-800">{vendor.plan || 'free'}</span>
                    <span className="mt-0.5 block text-xs text-slate-500">{vendor.credits ?? 0} credits</span>
                  </td>
                  <td className="px-4 py-3.5 text-slate-600">{formatDate(vendor.createdAt)}</td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${vendor.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : vendor.status === 'SUSPENDED' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>{vendor.status.toLowerCase()}</span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <div className="inline-flex gap-2">
                      <button type="button" disabled={saving} onClick={() => setEditingVendor({ ...vendor })} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Edit</button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void updateStatus(vendor)}
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50 ${vendor.status === 'ACTIVE' ? 'border-rose-200 text-rose-700 hover:bg-rose-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
                      >
                        {vendor.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
          <span className="text-xs text-slate-500">Page {page} of {pages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40">Previous</button>
            <button type="button" disabled={page >= pages || loading} onClick={() => setPage((value) => Math.min(pages, value + 1))} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40">Next</button>
          </div>
        </footer>
      </section>
    </div>
  );
};

export default VendorsPage;
