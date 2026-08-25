import type { ReactNode } from "react";

/** Standard content column for dashboard routes. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-h-full p-5 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6 pb-8">{children}</div>
    </div>
  );
}

/** Route heading: title + lede on the left, optional meta on the right. */
export function PageHead({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-rule pb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {lede && <p className="mt-1 text-sm text-muted">{lede}</p>}
      </div>
      {children}
    </div>
  );
}
