/**
 * Root-relative public URL. Empty during local dev and on a domain-root deploy.
 * Static export uses unoptimized images, so this also covers hero `src` values.
 */
export function publicPath(src: string) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!base || !src.startsWith("/") || src.startsWith("//")) {
    return src;
  }
  return `${base}${src}`;
}
