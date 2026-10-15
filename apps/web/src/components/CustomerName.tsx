import { useCustomerTags } from "../lib/customerTags";

/** A customer's name with its tags: New (joined in the last 90 days) and Top 10 (picked by BD). Others get no pill. */
export function CustomerTagPills({ isNew, isTop10 }: { isNew?: boolean; isTop10?: boolean }) {
  if (!isNew && !isTop10) return null;
  return (
    <>
      {isNew && <span className="ml-1.5 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-px align-middle text-[10px] font-bold uppercase leading-4 tracking-wide text-emerald-700">New</span>}
      {isTop10 && <span className="ml-1.5 inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px align-middle text-[10px] font-bold uppercase leading-4 tracking-wide text-amber-700">Top 10</span>}
    </>
  );
}

export function CustomerName({ name }: { name: string | null | undefined }) {
  const { data } = useCustomerTags();
  if (!name) return <>—</>;
  const tag = data?.find((c) => c.companyName === name);
  return (
    <>
      {name}
      <CustomerTagPills isNew={tag?.isNew} isTop10={tag?.isTop10} />
    </>
  );
}
