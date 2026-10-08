const GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || 'v26.0';

export function graphUrl(
  path: string
): string {
  const normalizedPath =
    path.startsWith('/')
      ? path
      : `/${path}`;

  return `https://graph.facebook.com/${GRAPH_VERSION}${normalizedPath}`;
}

export async function graphRequest(
  path: string,
  options?: RequestInit
): Promise<{
  response: Response;
  data: unknown;
}> {
  const response = await fetch(
    graphUrl(path),
    {
      ...options,
      cache: 'no-store',
    }
  );

  const text =
    await response.text();

  let data: unknown = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text,
    };
  }

  return {
    response,
    data,
  };
}