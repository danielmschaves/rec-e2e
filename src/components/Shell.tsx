import Link from "next/link";
import {
  LayoutDashboard,
  Briefcase,
  Code2,
  Mail,
  GitBranch,
  Zap,
  Plug,
} from "lucide-react";
import { initials, tint } from "@/lib/ui";
import type { User } from "@prisma/client";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/processes", label: "Processes", icon: Briefcase },
  { href: "/challenges", label: "Challenges", icon: Code2 },
  { href: "/drafts", label: "Drafts", icon: Mail },
  { href: "/flows", label: "Flows", icon: GitBranch },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/integrations", label: "Integrations", icon: Plug },
];

export function Shell({
  user,
  active,
  badges,
  children,
}: {
  user: User;
  active: string;
  /** Optional counts rendered next to nav items, keyed by href. */
  badges?: Record<string, number>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="px-5 py-5">
          <div className="text-sm font-semibold text-slate-900">Job search</div>
          <div className="text-xs text-slate-500">
            {user.name.split(" ")[0]}&apos;s processes
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2">
          {NAV.map((item) => {
            const isActive =
              item.href === "/" ? active === "/" : active.startsWith(item.href);
            const Icon = item.icon;
            const badge = badges?.[item.href];
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-indigo-50 font-medium text-indigo-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={2} />
                <span className="flex-1">{item.label}</span>
                {badge ? (
                  <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold ${tint(
                user.email,
              )}`}
            >
              {initials(user.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-900">{user.name}</div>
              <div className="truncate text-xs text-slate-500">{user.email}</div>
            </div>
          </div>
          <form action="/api/auth/signout" method="post">
            <button
              type="submit"
              className="mt-1 w-full rounded-lg px-3 py-1.5 text-left text-xs text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-b border-slate-200 bg-white px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
