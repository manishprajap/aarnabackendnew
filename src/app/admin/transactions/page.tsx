'use client';

import { useCallback, useEffect, useState } from 'react';

import { API_URL } from '@/lib/config';

type PaymentTransaction = {
  id: number;
  customerName: string | null;
  customerMobile: string | null;
  customerEmail: string | null;
  businessName: string | null;
  planName: string;
  amount: number;
  currency: string;
  status: 'created' | 'paid' | 'failed';
  method: string | null;
  orderId: string;
  paymentId: string | null;
  couponCode: string | null;
  discountAmount: number;
  createdAt: string;
};

type StatusFilter = 'all' | PaymentTransaction['status'];

const controlClass =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

function formatMoney(amountInPaise: number, currency: string) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 2,
  }).format(amountInPaise / 100);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export default function AdminTransactionsPage() {
  const [rows, setRows] = useState<PaymentTransaction[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [paidCount, setPaidCount] = useState(0);
  const [paidAmount, setPaidAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTransactions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        status,
      });
      const response = await fetch(`${API_URL}/admin/billing/transactions?${params}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Could not load payment transactions.');
      }
      setRows(data.transactions);
      setTotal(data.pagination.total);
      setPages(Math.max(1, data.pagination.pages));
      setPaidCount(data.summary.paidCount);
      setPaidAmount(data.summary.paidAmount);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load payment transactions.');
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTransactions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTransactions]);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <section className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-indigo-700">Admin / Billing</p>
          <h1 className="text-3xl font-semibold text-slate-950">Payment transactions</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Review customer payments, subscription plans, discounts and Razorpay references.
          </p>
        </div>
        <select
          aria-label="Filter transactions by payment status"
          className={controlClass}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as StatusFilter);
            setPage(1);
          }}
        >
          <option value="all">All payments</option>
          <option value="paid">Paid</option>
          <option value="created">Pending</option>
          <option value="failed">Failed</option>
        </select>
      </section>

      {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Successful payments</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{paidCount.toLocaleString('en-IN')}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Total amount received</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{formatMoney(paidAmount, 'INR')}</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-950">Payment history</h2>
            <p className="mt-1 text-sm text-slate-500">{total.toLocaleString('en-IN')} transactions</p>
          </div>
          <a href="/admin/billing" className="text-sm font-semibold text-indigo-700 hover:text-indigo-900">Manage plans & coupons</a>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading payment history…</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">No transactions found for this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Customer</th>
                  <th className="px-5 py-3 font-semibold">Plan</th>
                  <th className="px-5 py-3 font-semibold">Amount</th>
                  <th className="px-5 py-3 font-semibold">Payment</th>
                  <th className="px-5 py-3 font-semibold">Discount</th>
                  <th className="px-5 py-3 font-semibold">Order / payment ID</th>
                  <th className="px-5 py-3 font-semibold">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((transaction) => (
                  <tr key={transaction.id} className="align-top">
                    <td className="px-5 py-4">
                      <p className="font-medium text-slate-900">{transaction.customerName || transaction.businessName || 'Customer'}</p>
                      {transaction.businessName && transaction.customerName && <p className="text-xs text-slate-500">{transaction.businessName}</p>}
                      <p className="mt-1 text-xs text-slate-500">{transaction.customerMobile || '—'}</p>
                      {transaction.customerEmail && <p className="text-xs text-slate-500">{transaction.customerEmail}</p>}
                    </td>
                    <td className="px-5 py-4 text-slate-700">{transaction.planName}</td>
                    <td className="px-5 py-4 font-semibold text-slate-900">{formatMoney(transaction.amount, transaction.currency)}</td>
                    <td className="px-5 py-4">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${
                        transaction.status === 'paid'
                          ? 'bg-emerald-50 text-emerald-700'
                          : transaction.status === 'failed'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-amber-50 text-amber-700'
                      }`}>{transaction.status === 'created' ? 'Pending' : transaction.status}</span>
                      {transaction.method && <p className="mt-1 text-xs capitalize text-slate-500">{transaction.method}</p>}
                    </td>
                    <td className="px-5 py-4 text-slate-700">
                      {transaction.discountAmount > 0
                        ? <>{transaction.couponCode || 'Coupon'}<p className="text-xs text-slate-500">−{formatMoney(transaction.discountAmount, transaction.currency)}</p></>
                        : '—'}
                    </td>
                    <td className="max-w-52 px-5 py-4 text-xs text-slate-500">
                      <p className="break-all">Order: {transaction.orderId}</p>
                      <p className="mt-1 break-all">Payment: {transaction.paymentId || '—'}</p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-slate-600">{formatDate(transaction.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
          <p className="text-sm text-slate-500">Page {page} of {pages}</p>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
            <button type="button" disabled={page >= pages || loading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
