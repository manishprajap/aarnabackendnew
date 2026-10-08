'use client';

import { Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { NEXT_PUBLIC_BASE_PATH, API_URL } from '@/lib/config';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function CategoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

function SubcategoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v16M7 4h10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H7M7 15h6a2 2 0 0 1 2 2v3" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function VendorsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: <DashboardIcon /> },
  { label: 'Categories', href: '/admin/categories', icon: <CategoryIcon /> },
  { label: 'Subcategories', href: '/admin/subcategories', icon: <SubcategoryIcon /> },
  { label: 'Child categories', href: '/admin/childcategories', icon: <SubcategoryIcon /> },
  { label: 'Prompts', href: '/admin/prompts', icon: <PromptIcon /> },
  { label: 'Plans & coupons', href: '/admin/billing', icon: <DashboardIcon /> },
  { label: 'Vendors', href: '/admin/vendors', icon: <VendorsIcon /> },
];

/*
|--------------------------------------------------------------------------
| Active-item detection
|--------------------------------------------------------------------------
|
| All three "manage" nav items share the same base path
| (/admin/manage) and differ only by the ?tab= query, so matching on
| pathname alone would highlight all three at once. We also compare
| the tab query value.
|
| NOTE: NAV_ITEMS.href intentionally stays UNPREFIXED (no
| NEXT_PUBLIC_BASE_PATH). usePathname() from next/navigation already
| strips the configured basePath automatically, so comparing against
| unprefixed paths here is correct. The prefix is only added at the
| point where we render the actual <a href>, below.
|
*/

function isNavItemActive(
  navItem: NavItem,
  pathname: string,
  currentTab: string | null
): boolean {
  const [itemPath, itemQuery] = navItem.href.split('?');

  if (pathname !== itemPath) {
    return false;
  }

  if (!itemQuery) {
    return true;
  }

  const itemTab = new URLSearchParams(itemQuery).get('tab');

  return itemTab === currentTab;
}

/*
|--------------------------------------------------------------------------
| AdminShell — the part of the layout that needs useSearchParams()
|--------------------------------------------------------------------------
|
| Split out so it can be wrapped in its own Suspense boundary below,
| without the fallback flashing for the whole page shell.
|
*/

function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get('tab');

  const handleLogout = async () => {
    await fetch(`${API_URL}/admin/logout`, { method: 'POST' });
    window.location.href = `${NEXT_PUBLIC_BASE_PATH}/login`;
  };

  const activeItem =
    NAV_ITEMS.find((item) => isNavItemActive(item, pathname, currentTab)) ||
    NAV_ITEMS[0];

  const navLinks = NAV_ITEMS.map(function renderNavLink(navItem) {
  const isActive = isNavItemActive(navItem, pathname, currentTab);

  const linkClassName = isActive
    ? 'flex items-center gap-3 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white'
    : 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-100';

  return (
    <a
      key={navItem.href}
      href={`${NEXT_PUBLIC_BASE_PATH}${navItem.href}`}
      className={linkClassName}
    >
      {navItem.icon}
      {navItem.label}
    </a>
  );
});

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-800 bg-slate-900 px-4 py-4 sm:px-6 lg:min-h-screen lg:w-64 lg:border-b-0 lg:px-4 lg:py-6">
        <div className="mb-4 flex items-center gap-2.5 px-2 lg:mb-8">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            A
          </div>
          <div>
            <p className="text-sm font-semibold text-white">AI Project Ads</p>
            <p className="text-xs text-slate-500">Admin Console</p>
          </div>
        </div>

        <nav className="flex flex-wrap gap-1 lg:flex-1 lg:flex-col lg:space-y-1">{navLinks}</nav>

        <button
          onClick={handleLogout}
          className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-red-400 lg:mt-4"
        >
          <LogoutIcon />
          Logout
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
          <p className="text-sm font-medium text-slate-500">{activeItem.label}</p>

          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
              A
            </div>
            <span className="text-sm font-medium text-slate-700">Admin</span>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

/*
|--------------------------------------------------------------------------
| Default export — wraps AdminShell in Suspense so useSearchParams()
| inside it doesn't trigger a CSR bailout during prerender.
|--------------------------------------------------------------------------
*/

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <AdminShell>{children}</AdminShell>
    </Suspense>
  );
}