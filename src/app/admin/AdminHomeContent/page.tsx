
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, NEXT_PUBLIC_BASE_PATH } from '@/lib/config';

type ContentType = 'banner' | 'news';
type MediaType = 'image' | 'video' | 'none';

interface HomeContent {
  id: number;
  content_type: ContentType;
  title: string;
  description: string | null;
  media_url: string | null;
  media_type: MediaType;
  button_text: string | null;
  button_url: string | null;
  news_url: string | null;
  display_order: number;
  is_active: number | boolean;
}

interface BannerForm {
  title: string;
  description: string;
  media_type: 'image' | 'video';
  media_url: string;
  button_text: string;
  button_url: string;
  display_order: number;
  is_active: boolean;
}

interface NewsForm {
  title: string;
  description: string;
  news_url: string;
  display_order: number;
  is_active: boolean;
}

interface ApiResult {
  success?: boolean;
  message?: string;
  data?: HomeContent[];
  [key: string]: unknown;
}

const ENDPOINT = `${API_URL}/admin/home-content`;

const emptyBanner: BannerForm = {
  title: '',
  description: '',
  media_type: 'image',
  media_url: '',
  button_text: '',
  button_url: '',
  display_order: 0,
  is_active: true,
};

const emptyNews: NewsForm = {
  title: '',
  description: '',
  news_url: '',
  display_order: 0,
  is_active: true,
};

const isActive = (value: number | boolean) =>
  value === true || value === 1;

const isHttpUrl = (value: string) =>
  /^https?:\/\//i.test(value.trim());

const cardClass =
  'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6';

const cardTitleClass = 'mb-5 text-lg font-bold text-slate-900';

const labelClass = 'mb-2 block text-sm text-slate-600';

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#4f35f3] focus:outline-none focus:ring-2 focus:ring-[#4f35f3]/20';

const primaryBtn =
  'rounded-lg bg-[#4f35f3] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#4329d9] disabled:cursor-not-allowed disabled:opacity-60';

const secondaryBtn =
  'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50';

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-[#4f35f3]' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function ActiveRow({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-slate-700">Active</p>
        <p className="text-xs text-slate-500">
          Active content can be shown on the home page.
        </p>
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label="Active"
      />
    </div>
  );
}

export default function AdminHomeContentPage() {
  const [items, setItems] = useState<HomeContent[]>([]);

  const [bannerForm, setBannerForm] = useState<BannerForm>({
    ...emptyBanner,
  });

  const [newsForm, setNewsForm] = useState<NewsForm>({
    ...emptyNews,
  });

  const [editingBannerId, setEditingBannerId] =
    useState<number | null>(null);

  const [editingNewsId, setEditingNewsId] =
    useState<number | null>(null);

  const [filter, setFilter] = useState<'all' | ContentType>('all');

  const [loading, setLoading] = useState(true);
  const [savingBanner, setSavingBanner] = useState(false);
  const [savingNews, setSavingNews] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [needsAdminSession, setNeedsAdminSession] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);

  const toastTimer =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      setToast({ message, type });

      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
      }

      toastTimer.current = setTimeout(() => {
        setToast(null);
      }, 3500);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const request = useCallback(
    async (
      url: string,
      options: RequestInit = {},
    ): Promise<ApiResult> => {
      const headers = new Headers(options.headers);

      if (options.body !== undefined && options.body !== null) {
        headers.set('Content-Type', 'application/json');
      }

      const response = await fetch(url, {
        ...options,
        headers,
        cache: 'no-store',
        credentials: 'include',
      });

      const result = (await response.json().catch(() => ({}))) as ApiResult;

      if (!response.ok || result.success === false) {
        if (response.status === 401 || response.status === 403) {
          setNeedsAdminSession(true);
        }

        throw new Error(
          result.message || `Request failed (${response.status})`,
        );
      }

      return result;
    },
    [],
  );

  const loadContent = useCallback(async () => {
    setLoading(true);

    try {
      const result = await request(ENDPOINT);

      setItems(Array.isArray(result.data) ? result.data : []);
      setNeedsAdminSession(false);
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not load content',
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [request, notify]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const updateBanner = <K extends keyof BannerForm>(
    key: K,
    value: BannerForm[K],
  ) => {
    setBannerForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const updateNews = <K extends keyof NewsForm>(
    key: K,
    value: NewsForm[K],
  ) => {
    setNewsForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const resetBanner = () => {
    setBannerForm({ ...emptyBanner });
    setEditingBannerId(null);
  };

  const resetNews = () => {
    setNewsForm({ ...emptyNews });
    setEditingNewsId(null);
  };

  const startEdit = (item: HomeContent) => {
    if (item.content_type === 'banner') {
      setEditingBannerId(item.id);

      setBannerForm({
        title: item.title || '',
        description: item.description || '',
        media_type: item.media_type === 'video' ? 'video' : 'image',
        media_url: item.media_url || '',
        button_text: item.button_text || '',
        button_url: item.button_url || '',
        display_order: Number(item.display_order || 0),
        is_active: isActive(item.is_active),
      });
    } else {
      setEditingNewsId(item.id);

      setNewsForm({
        title: item.title || '',
        description: item.description || '',
        news_url: item.news_url || '',
        display_order: Number(item.display_order || 0),
        is_active: isActive(item.is_active),
      });
    }

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  const save = async (
    payload: Record<string, unknown>,
    editingId: number | null,
  ) => {
    await request(ENDPOINT, {
      method: editingId !== null ? 'PUT' : 'POST',
      body: JSON.stringify(
        editingId !== null
          ? { ...payload, id: editingId }
          : payload,
      ),
    });
  };

  const submitBanner = async (event: React.FormEvent) => {
    event.preventDefault();

    if (savingBanner) return;

    if (!bannerForm.title.trim()) {
      notify('Please enter the banner title.', 'error');
      return;
    }

    if (!bannerForm.media_url.trim()) {
      notify(
        `Please enter the ${
          bannerForm.media_type === 'video' ? 'video' : 'image'
        } URL.`,
        'error',
      );
      return;
    }

    if (!isHttpUrl(bannerForm.media_url)) {
      notify(
        'Media URL must start with http:// or https://.',
        'error',
      );
      return;
    }

    if (
      bannerForm.button_url.trim() &&
      !isHttpUrl(bannerForm.button_url)
    ) {
      notify(
        'Button URL must start with http:// or https://.',
        'error',
      );
      return;
    }

    if (
      bannerForm.button_text.trim() &&
      !bannerForm.button_url.trim()
    ) {
      notify(
        'Please enter the button URL for the button text.',
        'error',
      );
      return;
    }

    const payload = {
      content_type: 'banner',
      title: bannerForm.title.trim(),
      description: bannerForm.description.trim() || null,
      media_type: bannerForm.media_type,
      media_url: bannerForm.media_url.trim(),
      button_text: bannerForm.button_text.trim() || null,
      button_url: bannerForm.button_url.trim() || null,
      news_url: null,
      display_order: bannerForm.display_order,
      is_active: bannerForm.is_active,
    };

    setSavingBanner(true);

    try {
      await save(payload, editingBannerId);

      notify(
        editingBannerId !== null
          ? 'Banner updated successfully.'
          : 'Banner added successfully.',
      );

      resetBanner();
      await loadContent();
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not save banner',
        'error',
      );
    } finally {
      setSavingBanner(false);
    }
  };

  const submitNews = async (event: React.FormEvent) => {
    event.preventDefault();

    if (savingNews) return;

    if (!newsForm.title.trim()) {
      notify('Please enter the news headline.', 'error');
      return;
    }

    if (!newsForm.description.trim()) {
      notify('Please enter the news text.', 'error');
      return;
    }

    if (
      newsForm.news_url.trim() &&
      !isHttpUrl(newsForm.news_url)
    ) {
      notify(
        'News URL must start with http:// or https://.',
        'error',
      );
      return;
    }

    const payload = {
      content_type: 'news',
      title: newsForm.title.trim(),
      description: newsForm.description.trim(),
      media_type: 'none',
      media_url: null,
      button_text: null,
      button_url: null,
      news_url: newsForm.news_url.trim() || null,
      display_order: newsForm.display_order,
      is_active: newsForm.is_active,
    };

    setSavingNews(true);

    try {
      await save(payload, editingNewsId);

      notify(
        editingNewsId !== null
          ? 'News updated successfully.'
          : 'News added successfully.',
      );

      resetNews();
      await loadContent();
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not save news',
        'error',
      );
    } finally {
      setSavingNews(false);
    }
  };

  const toggleStatus = async (
    item: HomeContent,
    checked: boolean,
  ) => {
    try {
      await request(ENDPOINT, {
        method: 'PATCH',
        body: JSON.stringify({
          id: item.id,
          is_active: checked,
        }),
      });

      setItems((current) =>
        current.map((row) =>
          row.id === item.id
            ? { ...row, is_active: checked ? 1 : 0 }
            : row,
        ),
      );

      notify(
        checked ? 'Content activated.' : 'Content deactivated.',
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not update status',
        'error',
      );
    }
  };

  const confirmDelete = async () => {
    if (deleteId === null || deleting) return;

    setDeleting(true);

    try {
      await request(`${ENDPOINT}?id=${deleteId}`, {
        method: 'DELETE',
      });

      notify('Content deleted successfully.');

      if (editingBannerId === deleteId) resetBanner();
      if (editingNewsId === deleteId) resetNews();

      setDeleteId(null);
      await loadContent();
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not delete content',
        'error',
      );
    } finally {
      setDeleting(false);
    }
  };

  const visibleItems = items.filter(
    (item) => filter === 'all' || item.content_type === filter,
  );

  const tabs: Array<{
    value: 'all' | ContentType;
    label: string;
  }> = [
    { value: 'all', label: 'All' },
    { value: 'banner', label: 'Banners' },
    { value: 'news', label: 'Latest News' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Banners &amp; latest news
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Add homepage banners (image or video) and latest news updates.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadContent()}
          disabled={loading}
          className={secondaryBtn}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {needsAdminSession && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <h2 className="text-base font-bold text-amber-900">
            Authentication required
          </h2>
          <p className="mt-1 text-sm text-amber-800">
            Your admin session is missing or has expired. Please sign in again.{' '}
            <a
              href={`${NEXT_PUBLIC_BASE_PATH}/login`}
              className="font-semibold underline"
            >
              Go to admin sign in
            </a>
            .
          </p>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <form
          onSubmit={submitBanner}
          noValidate
          className={cardClass}
        >
          <h2 className={cardTitleClass}>
            {editingBannerId !== null ? 'Edit banner' : 'Add banner'}
          </h2>

          <div className="space-y-4">
            <div>
              <label className={labelClass} htmlFor="banner_title">
                Banner title
              </label>
              <input
                id="banner_title"
                className={inputClass}
                value={bannerForm.title}
                maxLength={255}
                onChange={(event) =>
                  updateBanner('title', event.target.value)
                }
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label
                  className={labelClass}
                  htmlFor="banner_media_type"
                >
                  Media type
                </label>
                <select
                  id="banner_media_type"
                  className={inputClass}
                  value={bannerForm.media_type}
                  onChange={(event) =>
                    updateBanner(
                      'media_type',
                      event.target.value as 'image' | 'video',
                    )
                  }
                >
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="banner_media_url">
                  {bannerForm.media_type === 'video'
                    ? 'Video URL'
                    : 'Image URL'}
                </label>
                <input
                  id="banner_media_url"
                  type="url"
                  className={inputClass}
                  value={bannerForm.media_url}
                  placeholder={
                    bannerForm.media_type === 'video'
                      ? 'https://example.com/video.mp4'
                      : 'https://example.com/image.jpg'
                  }
                  onChange={(event) =>
                    updateBanner('media_url', event.target.value)
                  }
                  required
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  className={labelClass}
                  htmlFor="banner_button_text"
                >
                  Button text (optional)
                </label>
                <input
                  id="banner_button_text"
                  className={inputClass}
                  value={bannerForm.button_text}
                  placeholder="Explore now"
                  onChange={(event) =>
                    updateBanner('button_text', event.target.value)
                  }
                />
              </div>

              <div>
                <label
                  className={labelClass}
                  htmlFor="banner_button_url"
                >
                  Button URL (optional)
                </label>
                <input
                  id="banner_button_url"
                  type="url"
                  className={inputClass}
                  value={bannerForm.button_url}
                  placeholder="https://"
                  onChange={(event) =>
                    updateBanner('button_url', event.target.value)
                  }
                />
              </div>
            </div>

            <div>
              <label
                className={labelClass}
                htmlFor="banner_description"
              >
                Description (optional)
              </label>
              <textarea
                id="banner_description"
                rows={3}
                className={`${inputClass} resize-y`}
                value={bannerForm.description}
                onChange={(event) =>
                  updateBanner('description', event.target.value)
                }
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="banner_order">
                Display order
              </label>
              <input
                id="banner_order"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                value={bannerForm.display_order}
                onChange={(event) =>
                  updateBanner(
                    'display_order',
                    Math.max(
                      0,
                      Math.floor(Number(event.target.value) || 0),
                    ),
                  )
                }
              />
            </div>

            <ActiveRow
              checked={bannerForm.is_active}
              onChange={(value) => updateBanner('is_active', value)}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={savingBanner}
              className={primaryBtn}
            >
              {savingBanner
                ? 'Saving...'
                : editingBannerId !== null
                  ? 'Update banner'
                  : 'Add banner'}
            </button>

            {editingBannerId !== null && (
              <button
                type="button"
                onClick={resetBanner}
                className={secondaryBtn}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>

        <form
          onSubmit={submitNews}
          noValidate
          className={cardClass}
        >
          <h2 className={cardTitleClass}>
            {editingNewsId !== null
              ? 'Edit latest news'
              : 'Add latest news'}
          </h2>

          <div className="space-y-4">
            <div>
              <label className={labelClass} htmlFor="news_title">
                News headline
              </label>
              <input
                id="news_title"
                className={inputClass}
                value={newsForm.title}
                maxLength={255}
                onChange={(event) =>
                  updateNews('title', event.target.value)
                }
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="news_description">
                News text
              </label>
              <textarea
                id="news_description"
                rows={6}
                className={`${inputClass} resize-y`}
                value={newsForm.description}
                onChange={(event) =>
                  updateNews('description', event.target.value)
                }
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="news_order">
                Display order
              </label>
              <input
                id="news_order"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                value={newsForm.display_order}
                onChange={(event) =>
                  updateNews(
                    'display_order',
                    Math.max(
                      0,
                      Math.floor(Number(event.target.value) || 0),
                    ),
                  )
                }
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="news_url">
                News article URL (optional)
              </label>
              <input
                id="news_url"
                type="url"
                className={inputClass}
                value={newsForm.news_url}
                placeholder="https://example.com/news"
                onChange={(event) =>
                  updateNews('news_url', event.target.value)
                }
              />
            </div>

            <ActiveRow
              checked={newsForm.is_active}
              onChange={(value) => updateNews('is_active', value)}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={savingNews}
              className={primaryBtn}
            >
              {savingNews
                ? 'Saving...'
                : editingNewsId !== null
                  ? 'Update news'
                  : 'Add news'}
            </button>

            {editingNewsId !== null && (
              <button
                type="button"
                onClick={resetNews}
                className={secondaryBtn}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </div>

      <section className={cardClass}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Saved content
            </h2>
            <p className="text-sm text-slate-500">
              {visibleItems.length}{' '}
              {visibleItems.length === 1 ? 'record' : 'records'}
            </p>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setFilter(tab.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  filter === tab.value
                    ? 'bg-[#4f35f3] text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-slate-200 p-10 text-center text-sm text-slate-500">
            Loading content...
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
            No content yet. Add your first banner or news item above.
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {visibleItems.map((item) => {
              const active = isActive(item.is_active);

              return (
                <li
                  key={item.id}
                  className="flex flex-col rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex flex-1 gap-4">
                    {item.media_url && item.media_type === 'image' && (
                      <img
                        src={item.media_url}
                        alt={item.title}
                        loading="lazy"
                        className="h-20 w-28 shrink-0 rounded-lg object-cover"
                      />
                    )}

                    {item.media_url && item.media_type === 'video' && (
                      <video
                        src={item.media_url}
                        controls
                        preload="metadata"
                        className="h-20 w-28 shrink-0 rounded-lg object-cover"
                      />
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            item.content_type === 'banner'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-violet-100 text-violet-700'
                          }`}
                        >
                          {item.content_type === 'banner'
                            ? item.media_type === 'video'
                              ? 'Video banner'
                              : 'Image banner'
                            : 'Latest news'}
                        </span>

                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            active
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {active ? 'Active' : 'Inactive'}
                        </span>

                        <span className="text-xs text-slate-400">
                          Order {item.display_order}
                        </span>
                      </div>

                      <h3 className="truncate text-base font-semibold text-slate-900">
                        {item.title}
                      </h3>

                      {item.description && (
                        <p className="mt-1 line-clamp-2 text-sm text-slate-600">
                          {item.description}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap gap-4 text-sm">
                        {item.media_type === 'video' && item.media_url && (
                          <a
                            href={item.media_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#4f35f3] hover:underline"
                          >
                            Open video
                          </a>
                        )}

                        {item.content_type === 'news' && item.news_url && (
                          <a
                            href={item.news_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#4f35f3] hover:underline"
                          >
                            Read news
                          </a>
                        )}

                        {item.button_text && item.button_url && (
                          <a
                            href={item.button_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#4f35f3] hover:underline"
                          >
                            {item.button_text}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={active}
                        onChange={(value) =>
                          void toggleStatus(item, value)
                        }
                        label={`Toggle ${item.title}`}
                      />
                      <span className="text-xs text-slate-500">
                        Show on home page
                      </span>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Edit
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeleteId(item.id)}
                        className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {deleteId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3
              id="delete-title"
              className="text-lg font-bold text-slate-900"
            >
              Delete content?
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              This permanently deletes the selected record.
            </p>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteId(null)}
                className={secondaryBtn}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg ${
            toast.type === 'success'
              ? 'bg-emerald-600'
              : 'bg-red-600'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
