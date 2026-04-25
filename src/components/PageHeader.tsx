interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export default function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h2 className="text-2xl font-semibold text-slate-800">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {action ? <div className="flex gap-2">{action}</div> : null}
    </header>
  );
}
