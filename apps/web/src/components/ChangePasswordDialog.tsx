import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { api, ApiError, setToken } from "../lib/api";
import { useToast } from "./Toast";

/** Change your own password: type the old one, then the new one twice. You stay signed in on this device (a fresh token comes back). */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    if (!currentPassword) return setError("Type your current password.");
    if (newPassword.length < 10) return setError("The new password needs at least 10 characters.");
    if (newPassword !== again) return setError("The two new passwords are not the same.");
    setSaving(true);
    try {
      const { token } = await api<{ token: string }>("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
      setToken(token);
      toast.success("Password changed. You are still signed in here; other devices are signed out.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4" onMouseDown={onClose}>
      <div className="card animate-scale-in w-full max-w-sm space-y-3 p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-900">
            <KeyRound className="h-4 w-4" strokeWidth={2.5} /> Change password
          </h2>
          <button className="btn-icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
        <div>
          <label className="label">Current password</label>
          <input className="field" type="password" autoFocus autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </div>
        <div>
          <label className="label">New password</label>
          <input className="field" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="min. 10 characters" />
        </div>
        <div>
          <label className="label">New password again</label>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <p className="text-micro text-slate-400">Forgot the current one? Ask your department admin to set a new password.</p>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={saving} onClick={submit}>
            {saving ? "Saving…" : "Change password"}
          </button>
        </div>
      </div>
    </div>
  );
}
