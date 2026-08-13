"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles, Send, Wrench, TriangleAlert } from "lucide-react";
import { askAssistantAction, type AssistantState } from "@/app/actions";

export type PanelMessage = {
  id: string;
  role: "USER" | "ASSISTANT" | "TOOL";
  content: string;
  toolSummary: string | null;
  isError: boolean;
};

/**
 * The assistant, in context.
 *
 * Rendered beside a process or challenge, already scoped to it — the server
 * loads that record into the model's context, so the first question doesn't
 * need to explain which company you mean.
 */
export function AssistantPanel({
  messages,
  opportunityId,
  challengeId,
  configured,
  suggestions,
  heading = "Assistant",
}: {
  messages: PanelMessage[];
  opportunityId?: string;
  challengeId?: string;
  configured: boolean;
  suggestions: string[];
  heading?: string;
}) {
  const [state, formAction] = useActionState<AssistantState, FormData>(
    askAssistantAction,
    {},
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, state]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <Sparkles className="h-4 w-4 text-indigo-600" strokeWidth={2} />
        <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
        <span className="ml-auto text-[11px] text-slate-400">
          Drafts only — never sends
        </span>
      </div>

      <div className="scroll-thin min-h-48 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Ask about this process, or get a follow-up drafted.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    if (inputRef.current) {
                      inputRef.current.value = s;
                      inputRef.current.focus();
                    }
                  }}
                  className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          if (message.role === "TOOL") {
            return (
              <div
                key={message.id}
                className="flex items-center gap-1.5 text-xs text-slate-400"
              >
                <Wrench className="h-3 w-3" strokeWidth={2} />
                {message.toolSummary ?? message.content}
              </div>
            );
          }

          const isUser = message.role === "USER";
          if (!isUser && !message.content) return null;

          return (
            <div
              key={message.id}
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                  isUser
                    ? "bg-indigo-600 text-white"
                    : message.isError
                      ? "bg-rose-50 text-rose-700"
                      : "bg-slate-100 text-slate-800"
                }`}
              >
                {message.content}
              </div>
            </div>
          );
        })}

        {state.error && (
          <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            {state.error}
          </div>
        )}

        <Thinking />
        <div ref={endRef} />
      </div>

      <form action={formAction} className="border-t border-slate-200 p-3">
        {opportunityId && (
          <input type="hidden" name="opportunityId" value={opportunityId} />
        )}
        {challengeId && <input type="hidden" name="challengeId" value={challengeId} />}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            name="message"
            rows={2}
            required
            disabled={!configured}
            placeholder={
              configured
                ? "Ask anything, or say what happened…"
                : "Set ANTHROPIC_API_KEY to enable the assistant"
            }
            className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:bg-slate-50"
          />
          <SendButton disabled={!configured} />
        </div>
      </form>
    </section>
  );
}

function Thinking() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      Working — this can take a few seconds while it reads your process.
    </div>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-700 disabled:bg-slate-300"
      aria-label="Send"
    >
      <Send className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}
