'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

import { API_URL } from '@/lib/config';

type Plan = {
  id: number;
  name: string;
  price: number;
  posters: number;
  durationDays: number;
  features: string | null;
  isActive: boolean;
};

type Coupon = {
  id: number;
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
};

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || 'Request failed.');
  }
  return data;
}

function asDateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function BillingAdminPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null);
  const [editingCouponId, setEditingCouponId] = useState<number | null>(null);

  const [planName, setPlanName] = useState('');
  const [planPrice, setPlanPrice] = useState('');
  const [planPosters, setPlanPosters] = useState('');
  const [planDuration, setPlanDuration] = useState('30');
  const [planFeatures, setPlanFeatures] = useState('');

  const [couponCode, setCouponCode] = useState('');
  const [couponType, setCouponType] = useState<'percent' | 'fixed'>('percent');
  const [couponValue, setCouponValue] = useState('');
  const [couponStart, setCouponStart] = useState('');
  const [couponEnd, setCouponEnd] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [planData, couponData] = await Promise.all([
        requestJson('/admin/billing/plans'),
        requestJson('/admin/billing/coupons'),
      ]);
      setPlans(planData.plans);
      setCoupons(couponData.coupons);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load billing settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const savePlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        name: planName.trim(),
        price: Number(planPrice),
        posters: Number(planPosters),
        durationDays: Number(planDuration),
        features: planFeatures.split('\n').map((line) => line.trim()).filter(Boolean),
      };
      await requestJson(
        editingPlanId ? `/admin/billing/plans/${editingPlanId}` : '/admin/billing/plans',
        { method: editingPlanId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }
      );
      setEditingPlanId(null);
      setPlanName('');
      setPlanPrice('');
      setPlanPosters('');
      setPlanDuration('30');
      setPlanFeatures('');
      setNotice(editingPlanId ? 'Plan updated.' : 'Plan created.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save plan.');
    } finally {
      setSaving(false);
    }
  };

  const saveCoupon = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        code: couponCode.trim().toUpperCase(),
        discountType: couponType,
        discountValue: Number(couponValue),
        startsAt: couponStart ? new Date(couponStart).toISOString() : null,
        endsAt: couponEnd ? new Date(couponEnd).toISOString() : null,
        isActive: true,
      };
      await requestJson(
        editingCouponId ? `/admin/billing/coupons/${editingCouponId}` : '/admin/billing/coupons',
        { method: editingCouponId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }
      );
      setEditingCouponId(null);
      setCouponCode('');
      setCouponType('percent');
      setCouponValue('');
      setCouponStart('');
      setCouponEnd('');
      setNotice(editingCouponId ? 'Coupon updated.' : 'Coupon created.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save coupon.');
    } finally {
      setSaving(false);
    }
  };

  const archivePlan = async (plan: Plan) => {
    if (!window.confirm(`Hide ${plan.name} from new subscriptions? Existing subscriptions remain unchanged.`)) return;
    try {
      await requestJson(`/admin/billing/plans/${plan.id}`, { method: 'DELETE' });
      setNotice('Plan hidden from new subscriptions.');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not archive plan.');
    }
  };

  const deleteCoupon = async (coupon: Coupon) => {
    if (!window.confirm(`Delete coupon ${coupon.code}?`)) return;
    try {
      await requestJson(`/admin/billing/coupons/${coupon.id}`, { method: 'DELETE' });
      setNotice('Coupon deleted.');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not delete coupon.');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Plans & discount coupons</h1>
        <p className="mt-1 text-sm text-slate-500">Create subscription options and manage customer discount codes.</p>
      </div>
      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <section className="grid gap-6 xl:grid-cols-2">
        <form onSubmit={savePlan} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">{editingPlanId ? 'Edit subscription plan' : 'Create subscription plan'}</h2>
          <label className="block text-sm font-medium text-slate-700">Plan name<input required className={`${inputClass} mt-1`} value={planName} onChange={(event) => setPlanName(event.target.value)} /></label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm font-medium text-slate-700">Price (₹)<input required type="number" min="1" step="1" className={`${inputClass} mt-1`} value={planPrice} onChange={(event) => setPlanPrice(event.target.value)} /></label>
            <label className="text-sm font-medium text-slate-700">Banners / period<input required type="number" min="1" className={`${inputClass} mt-1`} value={planPosters} onChange={(event) => setPlanPosters(event.target.value)} /></label>
            <label className="text-sm font-medium text-slate-700">Duration (days)<input required type="number" min="1" className={`${inputClass} mt-1`} value={planDuration} onChange={(event) => setPlanDuration(event.target.value)} /></label>
          </div>
          <label className="block text-sm font-medium text-slate-700">Features (one per line)<textarea rows={4} className={`${inputClass} mt-1`} value={planFeatures} onChange={(event) => setPlanFeatures(event.target.value)} /></label>
          <div className="flex gap-2">
            <button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : editingPlanId ? 'Save plan' : 'Create plan'}</button>
            {editingPlanId && <button type="button" onClick={() => setEditingPlanId(null)} className="rounded-lg border px-4 py-2.5 text-sm">Cancel</button>}
          </div>
        </form>

        <form onSubmit={saveCoupon} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">{editingCouponId ? 'Edit discount coupon' : 'Create discount coupon'}</h2>
          <label className="block text-sm font-medium text-slate-700">Coupon code<input required minLength={3} className={`${inputClass} mt-1 uppercase`} value={couponCode} onChange={(event) => setCouponCode(event.target.value.toUpperCase())} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-slate-700">Discount type<select className={`${inputClass} mt-1`} value={couponType} onChange={(event) => setCouponType(event.target.value as 'percent' | 'fixed')}><option value="percent">Percentage</option><option value="fixed">Fixed amount (₹)</option></select></label>
            <label className="text-sm font-medium text-slate-700">Value<input required type="number" min="1" max={couponType === 'percent' ? 99 : 1000000} className={`${inputClass} mt-1`} value={couponValue} onChange={(event) => setCouponValue(event.target.value)} /></label>
            <label className="text-sm font-medium text-slate-700">Starts at (optional)<input type="datetime-local" className={`${inputClass} mt-1`} value={couponStart} onChange={(event) => setCouponStart(event.target.value)} /></label>
            <label className="text-sm font-medium text-slate-700">Expires at (optional)<input type="datetime-local" className={`${inputClass} mt-1`} value={couponEnd} onChange={(event) => setCouponEnd(event.target.value)} /></label>
          </div>
          <div className="flex gap-2">
            <button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : editingCouponId ? 'Save coupon' : 'Create coupon'}</button>
            {editingCouponId && <button type="button" onClick={() => setEditingCouponId(null)} className="rounded-lg border px-4 py-2.5 text-sm">Cancel</button>}
          </div>
        </form>
      </section>

      {loading ? <p className="text-sm text-slate-500">Loading billing data…</p> : (
        <>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b px-5 py-4 text-lg font-semibold">Subscription plans</h2>
            <div className="divide-y">
              {plans.map((plan) => (
                <div key={plan.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div><strong>{plan.name}</strong><p className="text-sm text-slate-500">₹{plan.price} · {plan.posters} banners / {plan.durationDays} days · {plan.isActive ? 'Active' : 'Hidden'}</p></div>
                  <div className="flex gap-2">
                    <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => { setEditingPlanId(plan.id); setPlanName(plan.name); setPlanPrice(String(plan.price)); setPlanPosters(String(plan.posters)); setPlanDuration(String(plan.durationDays)); setPlanFeatures(plan.features || ''); }}>Edit</button>
                    {plan.isActive && <button className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700" onClick={() => void archivePlan(plan)}>Hide</button>}
                  </div>
                </div>
              ))}
              {plans.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">No plans configured yet.</p>}
            </div>
          </section>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b px-5 py-4 text-lg font-semibold">Discount coupons</h2>
            <div className="divide-y">
              {coupons.map((coupon) => (
                <div key={coupon.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div><strong>{coupon.code}</strong><p className="text-sm text-slate-500">{coupon.discountType === 'percent' ? `${coupon.discountValue}% off` : `₹${coupon.discountValue} off`} · {coupon.isActive ? 'Active' : 'Inactive'}{coupon.endsAt ? ` · Expires ${new Date(coupon.endsAt).toLocaleString()}` : ''}</p></div>
                  <div className="flex gap-2">
                    <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => { setEditingCouponId(coupon.id); setCouponCode(coupon.code); setCouponType(coupon.discountType); setCouponValue(String(coupon.discountValue)); setCouponStart(asDateInput(coupon.startsAt)); setCouponEnd(asDateInput(coupon.endsAt)); }}>Edit</button>
                    <button className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700" onClick={() => void deleteCoupon(coupon)}>Delete</button>
                  </div>
                </div>
              ))}
              {coupons.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">No coupons configured yet.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
