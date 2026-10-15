import { useState } from "react";
import { Check, KeyRound, Pencil, Plus, ShieldCheck, Star, UserCheck, Users as UsersIcon, X } from "lucide-react";
import { useCreateUser, useGrantRole, useRenameUser, useResetPassword, useRevokeRole, useSetDeptAdmin, useSetUserActive, useUsers } from "../lib/hooks";
import { ALL_ROLES, type ManagedUser, type RoleName } from "../lib/types";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatEmployeeId } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const CHANGED_BY: Record<string, string> = { ADMIN: "by admin", USER: "by himself", SYSTEM: "by system" };

/**
 * The logins. The System Admin sees every account; the admin of a department sees (and manages) only that department's people
 * — the server decides the list, this page only hides what the person may not do.
 */
export function UsersPage() {
  const { user: me, isAdmin } = useAuth();
  const { data: users, isLoading } = useUsers();
  const [showNewUser, setShowNewUser] = useState(false);
  const [search, setSearch] = useState("");

  const myDepts = me?.deptAdminOf ?? [];
  const activeCount = users?.filter((u) => u.isActive).length ?? 0;
  const adminCount = users?.filter((u) => u.roles.includes("ADMIN") || u.deptAdminOf.length > 0).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredUsers = users?.filter((u) => !q || u.email.toLowerCase().includes(q) || (u.loginId ?? "").includes(q) || u.fullName.toLowerCase().includes(q));

  const pg = useClientPaging(filteredUsers);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-slate-100 text-slate-600">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{isAdmin ? "Users" : `My Team — ${myDepts.join(", ")}`}</h1>
            <p className="text-sm text-slate-500">
              {isAdmin
                ? "Every login, its department, and the one admin of each department."
                : "The logins of your department. You create them, set their login ID and password, and reset a password when someone forgets it."}
            </p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowNewUser((s) => !s)}>
          {showNewUser ? (
            <>
              <X className="h-4 w-4" strokeWidth={2.5} /> Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" strokeWidth={2.5} /> New Login
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={UsersIcon} label="Total Logins" value={users?.length ?? 0} accent="slate" />
        <StatTile icon={UserCheck} label="Active" value={activeCount} accent="emerald" />
        <StatTile icon={ShieldCheck} label="Admins" value={adminCount} accent="violet" />
      </div>

      {showNewUser && <NewUserForm isSystemAdmin={isAdmin} myDepts={myDepts} onDone={() => setShowNewUser(false)} />}

      {!isLoading && !!users?.length && <SearchBar value={search} onChange={setSearch} placeholder="Search by name, login ID or email…" />}

      {isLoading ? (
        <SkeletonRows rows={5} cols={5} />
      ) : !users?.length ? (
        <EmptyState icon={UsersIcon} title="No logins yet" hint="Use New Login to make the first one." accent="slate" />
      ) : !filteredUsers?.length ? (
        <EmptyState icon={UsersIcon} title="No matching logins" hint="Try a different search." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Login ID</th>
                  <th>Full Name</th>
                  <th>Department</th>
                  <th>Password / Last login</th>
                  <th className="text-center">Status</th>
                  <th className="text-center">Password</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((u) => (
                  <UserRow key={u.id} user={u} isSystemAdmin={isAdmin} isMe={u.id === me?.id} />
                ))}
              </tbody>
            </table>
            <ClientPager pg={pg} />
          </div>
        </div>
      )}
    </div>
  );
}

function NewUserForm({ isSystemAdmin, myDepts, onDone }: { isSystemAdmin: boolean; myDepts: RoleName[]; onDone: () => void }) {
  const createUser = useCreateUser();
  const toast = useToast();
  const [loginId, setLoginId] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  // A department admin makes logins only in his own department (the picker is there only if he runs more than one).
  const [role, setRole] = useState<RoleName | "">(isSystemAdmin ? "" : (myDepts[0] ?? ""));
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!loginId.trim() || !fullName.trim() || password.length < 10) {
      setError("Login ID, full name and a password of at least 10 characters are required.");
      return;
    }
    if (!isSystemAdmin && !role) {
      setError("Pick the department.");
      return;
    }
    try {
      await createUser.mutateAsync({ loginId: loginId.trim(), fullName: fullName.trim(), password, email: email.trim() || undefined, role: role || undefined });
      toast.success(`Login "${loginId.trim().toLowerCase()}" created. Tell ${fullName.trim()} the login ID and the password you typed.`);
      setLoginId("");
      setFullName("");
      setPassword("");
      setEmail("");
      onDone();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not create the login";
      setError(msg);
      toast.error(msg);
    }
  }

  const roleChoices = isSystemAdmin ? ALL_ROLES : myDepts;

  return (
    <div className="card animate-slide-up space-y-3 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className="label">Login ID</label>
          <input className="field" value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="e.g. neha.bd" autoComplete="off" />
          <p className="mt-1 text-micro text-slate-400">3–40 letters, numbers, dot or dash. No spaces.</p>
        </div>
        <div>
          <label className="label">Full Name</label>
          <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="field" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min. 10 characters" autoComplete="off" />
          <p className="mt-1 text-micro text-slate-400">You type it and tell the person. He can change it himself after.</p>
        </div>
        <div>
          <label className="label">Email (optional)</label>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </div>
        <div>
          <label className="label">Department</label>
          {!isSystemAdmin && roleChoices.length === 1 ? (
            <div className="field bg-slate-50 font-bold text-slate-700">{roleChoices[0]}</div>
          ) : (
            <ItemPicker items={roleChoices.map((r) => ({ id: r, name: r }))} value={role} onChange={(v) => setRole(v as RoleName)} placeholder={isSystemAdmin ? "— No department yet —" : "— Pick —"} />
          )}
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" disabled={createUser.isPending} onClick={handleSubmit}>
          {createUser.isPending ? "Creating…" : "Create Login"}
        </button>
      </div>
    </div>
  );
}

/** One click-to-edit text cell (login ID, name or email). */
function EditableText({ value, mono, title, onSave, saving, type = "text" }: { value: string; mono?: boolean; title: string; onSave: (v: string) => Promise<void>; saving: boolean; type?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === value) return setEditing(false);
    if (await onSave(trimmed).then(() => true, () => false)) setEditing(false);
  }

  if (!editing)
    return (
      <button
        className={`group flex items-center gap-1.5 text-left ${mono ? "font-mono text-xs" : "text-xs font-bold"}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title={title}
      >
        {value || "—"}
        <Pencil className="h-3 w-3 shrink-0 text-slate-300 group-hover:text-slate-500" strokeWidth={2.25} />
      </button>
    );
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        type={type}
        className="field !py-1 !px-2 text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button className="btn-icon shrink-0" disabled={saving} onClick={save} title="Save">
        <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
      </button>
      <button className="btn-icon shrink-0" onClick={() => setEditing(false)} title="Cancel">
        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}

function UserRow({ user, isSystemAdmin, isMe }: { user: ManagedUser; isSystemAdmin: boolean; isMe: boolean }) {
  const grantRole = useGrantRole();
  const revokeRole = useRevokeRole();
  const setActive = useSetUserActive();
  const setDeptAdmin = useSetDeptAdmin();
  const resetPassword = useResetPassword();
  const renameUser = useRenameUser();
  const toast = useToast();
  const [addingRole, setAddingRole] = useState<RoleName | "">("");
  const [showReset, setShowReset] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const availableRoles = ALL_ROLES.filter((r) => !user.roles.includes(r));
  // A department admin cannot switch himself off, change his own login ID or reset his own password (his own password he changes himself).
  const lockedSelf = isMe && !isSystemAdmin;

  async function save(patch: { fullName?: string; loginId?: string; email?: string }, done: string) {
    try {
      await renameUser.mutateAsync({ userId: user.id, ...patch });
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
      throw err;
    }
  }

  return (
    <tr className="align-top">
      <td className="font-mono text-tiny font-bold text-slate-500">{formatEmployeeId(user.employeeId)}</td>
      <td className="text-slate-700">
        {lockedSelf ? (
          <span className="font-mono text-xs">{user.loginId ?? "—"}</span>
        ) : (
          <EditableText
            mono
            value={user.loginId ?? ""}
            saving={renameUser.isPending}
            title="Click to change — signs this person out"
            onSave={(v) => save({ loginId: v }, "Login ID changed — this person was signed out and logs in with the new ID.")}
          />
        )}
        <p className="mt-0.5 text-micro text-slate-400">{user.email}</p>
      </td>
      <td>
        <EditableText value={user.fullName} saving={renameUser.isPending} title="Click to rename" onSave={(v) => save({ fullName: v }, "Name updated.")} />
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-1.5">
          {user.roles.length === 0 && <span className="text-micro text-slate-400">No department</span>}
          {user.roles.map((r) => {
            const isAdminOfIt = user.deptAdminOf.includes(r);
            return (
              <span key={r} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-bold uppercase ${isAdminOfIt ? "border-amber-300 bg-amber-50 text-amber-800" : "border-brand-200 bg-brand-50 text-brand-700"}`}>
                {r}
                {isAdminOfIt && <span className="normal-case">· admin</span>}
                {/* The System Admin picks the one admin of a department: the star moves the admin to this person */}
                {isSystemAdmin && r !== "ADMIN" && (
                  <button
                    onClick={() => {
                      if (isAdminOfIt && !window.confirm(`Take the ${r} admin away from ${user.fullName}?`)) return;
                      if (!isAdminOfIt && !window.confirm(`Make ${user.fullName} the admin of ${r}? The earlier ${r} admin (if any) stops being admin.`)) return;
                      setDeptAdmin.mutate(
                        { userId: user.id, role: r, isDeptAdmin: !isAdminOfIt },
                        { onSuccess: () => toast.success(isAdminOfIt ? `${r} admin removed.` : `${user.fullName} is now the ${r} admin.`), onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not change the admin") },
                      );
                    }}
                    className={isAdminOfIt ? "text-amber-500 hover:text-amber-700" : "text-brand-300 hover:text-amber-500"}
                    title={isAdminOfIt ? "Take away the department admin" : "Make department admin (one per department)"}
                  >
                    <Star className="h-3 w-3" strokeWidth={2.5} fill={isAdminOfIt ? "currentColor" : "none"} />
                  </button>
                )}
                {isSystemAdmin && (
                  <button
                    onClick={() => window.confirm(`Revoke ${r} from ${user.fullName}? This takes effect immediately, even on a session they're already logged into.`) && revokeRole.mutate({ userId: user.id, role: r })}
                    className="text-brand-400 hover:text-rose-600"
                    title="Revoke role"
                  >
                    <X className="h-2.5 w-2.5" strokeWidth={3} />
                  </button>
                )}
              </span>
            );
          })}
          {isSystemAdmin && availableRoles.length > 0 && (
            <div className="w-32">
              <ItemPicker
                items={availableRoles.map((r) => ({ id: r, name: r }))}
                value={addingRole}
                placeholder="+ Add role"
                onChange={(v) => {
                  const r = v as RoleName;
                  if (r) {
                    grantRole.mutate({ userId: user.id, role: r });
                    toast.success(`Granted ${r} to ${user.fullName}.`);
                  }
                  setAddingRole("");
                }}
              />
            </div>
          )}
        </div>
      </td>
      <td className="text-tiny text-slate-500">
        <p>
          Password changed: <span className="font-bold text-slate-700">{fmtWhen(user.passwordChangedAt)}</span>
          {user.passwordChangedBy && <span> ({CHANGED_BY[user.passwordChangedBy] ?? user.passwordChangedBy})</span>}
        </p>
        <p>
          Last login: <span className="font-bold text-slate-700">{fmtWhen(user.lastLoginAt)}</span>
        </p>
      </td>
      <td className="text-center">
        <button
          disabled={lockedSelf}
          onClick={() => setActive.mutate({ userId: user.id, isActive: !user.isActive })}
          className={`rounded-full px-2.5 py-1 text-micro font-bold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${user.isActive ? "bg-emerald-100 text-emerald-700 hover:bg-rose-100 hover:text-rose-700" : "bg-slate-200 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700"}`}
          title={lockedSelf ? "You cannot switch off your own login" : user.isActive ? "Click to deactivate" : "Click to activate"}
        >
          {user.isActive ? "Active" : "Inactive"}
        </button>
      </td>
      <td className="text-center">
        {lockedSelf ? (
          <span className="text-micro text-slate-400">Change your own from the profile menu</span>
        ) : (
          <>
            <button className="btn-ghost btn-sm mx-auto" onClick={() => setShowReset((s) => !s)}>
              <KeyRound className="h-3 w-3" strokeWidth={2.5} /> Set new password
            </button>
            {showReset && (
              <div className="mt-2 flex flex-col gap-1.5">
                <input type="text" className="field !py-1.5 text-tiny" placeholder="New password (min. 10 chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="off" />
                <button
                  className="btn-primary btn-sm"
                  disabled={resetPassword.isPending}
                  onClick={async () => {
                    if (newPassword.length < 10) return setResetMessage("Needs at least 10 characters.");
                    try {
                      await resetPassword.mutateAsync({ userId: user.id, newPassword });
                      setResetMessage(null);
                      toast.success(`New password set for ${user.loginId ?? user.email}. Tell them — they are signed out.`);
                      setNewPassword("");
                      setShowReset(false);
                    } catch (err) {
                      const msg = err instanceof ApiError ? err.message : "Could not set the password";
                      setResetMessage(msg);
                      toast.error(msg);
                    }
                  }}
                >
                  Set Password
                </button>
                {resetMessage && <p className="text-micro text-rose-600">{resetMessage}</p>}
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
