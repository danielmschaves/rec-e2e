import Link from "next/link";
import { redirect } from "next/navigation";
import { Mail, Send, Trash2, Sparkles, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { googleConfigured } from "@/lib/env";
import { Shell, PageHeader } from "@/components/Shell";
import { sendDraftAction, discardDraftAction, updateDraftAction } from "@/app/actions";
import { relativeTime, inputClass } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [drafts, sent, account] = await Promise.all([
    prisma.emailDraft.findMany({
      where: { userId: user.id, status: "DRAFT" },
      include: { opportunity: { include: { company: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.emailDraft.findMany({
      where: { userId: user.id, status: "SENT" },
      include: { opportunity: { include: { company: true } } },
      orderBy: { sentAt: "desc" },
      take: 10,
    }),
    prisma.googleAccount.findUnique({ where: { userId: user.id } }),
  ]);

  const canSend = Boolean(account) && googleConfigured();

  return (
    <Shell user={user} active="/drafts" badges={{ "/drafts": drafts.length }}>
      <PageHeader
        title="Drafts"
        subtitle="Nothing here has been sent. Read it, edit it, then send it yourself."
      />

      <div className="space-y-6 p-6">
        <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2} />
          <p className="text-sm text-slate-600">
            The assistant can write email but has no ability to send it. Every message leaves
            your account only when you press send on this page.
          </p>
        </div>

        {drafts.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <Mail className="mx-auto h-6 w-6 text-slate-300" strokeWidth={2} />
            <p className="mt-2 text-sm text-slate-500">
              No drafts waiting. Ask the assistant on any process to write a follow-up.
            </p>
          </div>
        )}

        {drafts.map((draft) => (
          <section
            key={draft.id}
            className="overflow-hidden rounded-xl border border-violet-200 bg-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-violet-50/40 px-5 py-3">
              <div className="flex items-center gap-2">
                {draft.createdBy === "ASSISTANT" && (
                  <span className="flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                    Assistant
                  </span>
                )}
                <span className="text-sm font-medium text-slate-900">
                  {draft.opportunity ? (
                    <Link
                      href={`/processes/${draft.opportunityId}`}
                      className="hover:underline"
                    >
                      {draft.opportunity.company.name}
                    </Link>
                  ) : (
                    "No process"
                  )}
                </span>
              </div>
              <span className="text-xs text-slate-400">
                drafted {relativeTime(draft.createdAt)}
              </span>
            </div>

            {draft.rationale && (
              <p className="border-b border-slate-100 px-5 py-2.5 text-xs text-slate-500 italic">
                {draft.rationale}
              </p>
            )}

            <form action={updateDraftAction} className="space-y-3 p-5">
              <input type="hidden" name="draftId" value={draft.id} />
              <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">To</span>
                  <input name="toEmail" defaultValue={draft.toEmail} className={inputClass} />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">Subject</span>
                  <input name="subject" defaultValue={draft.subject} className={inputClass} />
                </label>
              </div>
              <textarea
                name="body"
                rows={10}
                defaultValue={draft.body}
                className={`${inputClass} leading-relaxed`}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save edits
              </button>
            </form>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
              <form action={sendDraftAction}>
                <input type="hidden" name="draftId" value={draft.id} />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:bg-slate-300"
                >
                  <Send className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Send it
                </button>
              </form>

              <form action={discardDraftAction}>
                <input type="hidden" name="draftId" value={draft.id} />
                <button
                  type="submit"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-white"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                  Discard
                </button>
              </form>

              {!canSend && (
                <span className="text-xs text-slate-500">
                  <Link href="/integrations" className="text-indigo-600 hover:underline">
                    Connect Google
                  </Link>{" "}
                  to send from here — or copy the text out.
                </span>
              )}
            </div>
          </section>
        ))}

        {sent.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">Sent</h2>
            </div>
            <ul className="divide-y divide-slate-100">
              {sent.map((draft) => (
                <li key={draft.id} className="px-5 py-3">
                  <div className="truncate text-sm text-slate-900">{draft.subject}</div>
                  <div className="text-xs text-slate-500">
                    to {draft.toEmail}
                    {draft.opportunity && ` · ${draft.opportunity.company.name}`} ·{" "}
                    {relativeTime(draft.sentAt)}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Shell>
  );
}
