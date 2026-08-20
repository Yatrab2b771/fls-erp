import { useState } from "react";
import { Check, KeyRound, Pencil, Plus, ShieldCheck, UserCheck, Users as UsersIcon, X } from "lucide-react";
import { useCreateUser, useGrantRole, useRenameUser, useResetPassword, useRevokeRole, useSetUserActive, useUsers } from "../lib/hooks";
import { ALL_ROLES, type ManagedUser, type RoleName } from "../lib/types";
import { ApiError } from "../lib/api";
import { formatEmployeeId } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

export function UsersPage() {
  const { data: users, isLoading } = useUsers();
  const [showNewUser, setShowNewUser] = useState(false);
  const [search, setSearch] = useState("");

  const activeCount = users?.filter((u) => u.isActive).length ?? 0;
  const adminCount = users?.filter((u) => u.roles.includes("ADMIN")).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredUsers = users?.filter((u) => !q || u.email.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-slate-100 text-slate-600">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Users</h1>
            <p className="text-sm text-slate-500">Every account, its login, its department role(s), and whether it's active.</p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowNewUser((s) => !s)}>
          {showNewUser ? (
            <>
              <X className="h-4 w-4" strokeWidth={2.5} /> Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" strokeWidth={2.5} /> New User
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={UsersIcon} label="Total Accounts" value={users?.length ?? 0} accent="slate" />
        <StatTile icon={UserCheck} label="Active" value={activeCount} accent="emerald" />
        <StatTile icon={ShieldCheck} label="Admins" value={adminCount} accent="violet" />
      </div>

      {showNewUser && <NewUserForm onDone={() => setShowNewUser(false)} />}

      {!isLoading && !!users?.length && <SearchBar value={search} onChange={setSearch} placeholder="Search by name or email…" />}

      {isLoading ? (
        <SkeletonRows rows={5} cols={5} />
      ) : !users?.length ? (
        <EmptyState icon={UsersIcon} title="No user accounts yet" accent="slate" />
      ) : !filteredUsers?.length ? (
        <EmptyState icon={UsersIcon} title="No matching accounts" hint="Try a different search." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Email (login id)</th>
                  <th>Full Name</th>
                  <th>Roles</th>
                  <th className="text-center">Status</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <UserRow key={u.id} user={u} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function NewUserForm({ onDone }: { onDone: () => void }) {
  const createUser = useCreateUser();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<RoleName | "">("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!email.trim() || !fullName.trim() || password.length < 10) {
      setError("Email, full name, and a password of at least 10 characters are required.");
      return;
    }
    try {
      await createUser.mutateAsync({ email: email.trim(), fullName: fullName.trim(), password, role: role || undefined });
      toast.success(`Account created for ${email.trim()}.`);
      setEmail("");
      setFullName("");
      setPassword("");
      setRole("");
      onDone();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not create user";
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="card animate-slide-up space-y-3 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Email (login id)</label>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@fls.local" />
        </div>
        <div>
          <label className="label">Full Name</label>
          <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <label className="label">Initial Password</label>
          <input className="field" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min. 10 characters" />
        </div>
        <div>
          <label className="label">Department Role</label>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as RoleName)}>
            <option value="">— No role yet —</option>
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" disabled={createUser.isPending} onClick={handleSubmit}>
          {createUser.isPending ? "Creating…" : "Create User"}
        </button>
      </div>
    </div>
  );
}

function UserRow({ user }: { user: ManagedUser }) {
  const grantRole = useGrantRole();
  const revokeRole = useRevokeRole();
  const setActive = useSetUserActive();
  const resetPassword = useResetPassword();
  const renameUser = useRenameUser();
  const toast = useToast();
  const [addingRole, setAddingRole] = useState<RoleName | "">("");
  const [showReset, setShowReset] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(user.fullName);

  const availableRoles = ALL_ROLES.filter((r) => !user.roles.includes(r));

  async function handleSaveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    if (trimmed === user.fullName) return setEditingName(false);
    try {
      await renameUser.mutateAsync({ userId: user.id, fullName: trimmed });
      toast.success("Name updated.");
      setEditingName(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update name");
    }
  }

  return (
    <tr className="align-top">
      <td className="font-mono text-[11px] font-bold text-slate-500">{formatEmployeeId(user.employeeId)}</td>
      <td className="font-mono text-xs text-slate-700">{user.email}</td>
      <td className="text-xs font-bold text-slate-700">
        {editingName ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              className="field !py-1 !px-2 text-xs"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
                if (e.key === "Escape") {
                  setNameDraft(user.fullName);
                  setEditingName(false);
                }
              }}
            />
            <button className="btn-icon shrink-0" disabled={renameUser.isPending} onClick={handleSaveName} title="Save">
              <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
            </button>
            <button
              className="btn-icon shrink-0"
              onClick={() => {
                setNameDraft(user.fullName);
                setEditingName(false);
              }}
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </div>
        ) : (
          <button className="group flex items-center gap-1.5 text-left" onClick={() => setEditingName(true)} title="Click to rename">
            {user.fullName}
            <Pencil className="h-3 w-3 shrink-0 text-slate-300 group-hover:text-slate-500" strokeWidth={2.25} />
          </button>
        )}
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-1.5">
          {user.roles.length === 0 && <span className="text-[10px] text-slate-400">No roles</span>}
          {user.roles.map((r) => (
            <span key={r} className="flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[9px] font-bold uppercase text-brand-700">
              {r}
              <button onClick={() => revokeRole.mutate({ userId: user.id, role: r })} className="text-brand-400 hover:text-rose-600" title="Revoke role">
                <X className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            </span>
          ))}
          {availableRoles.length > 0 && (
            <select
              className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-[10px] font-bold text-slate-500"
              value={addingRole}
              onChange={(e) => {
                const r = e.target.value as RoleName;
                if (r) {
                  grantRole.mutate({ userId: user.id, role: r });
                  toast.success(`Granted ${r} to ${user.fullName}.`);
                }
                setAddingRole("");
              }}
            >
              <option value="">+ Add role</option>
              {availableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </div>
      </td>
      <td className="text-center">
        <button
          onClick={() => setActive.mutate({ userId: user.id, isActive: !user.isActive })}
          className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase transition-colors ${user.isActive ? "bg-emerald-100 text-emerald-700 hover:bg-rose-100 hover:text-rose-700" : "bg-slate-200 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700"}`}
          title={user.isActive ? "Click to deactivate" : "Click to activate"}
        >
          {user.isActive ? "Active" : "Inactive"}
        </button>
      </td>
      <td className="text-center">
        <button className="btn-ghost btn-sm mx-auto" onClick={() => setShowReset((s) => !s)}>
          <KeyRound className="h-3 w-3" strokeWidth={2.5} /> Reset password
        </button>
        {showReset && (
          <div className="mt-2 flex flex-col gap-1.5">
            <input
              type="text"
              className="field !py-1.5 text-[11px]"
              placeholder="New password (min. 10 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="btn-primary btn-sm"
              disabled={resetPassword.isPending}
              onClick={async () => {
                if (newPassword.length < 10) return setResetMessage("Needs at least 10 characters.");
                try {
                  await resetPassword.mutateAsync({ userId: user.id, newPassword });
                  setResetMessage("Password updated.");
                  toast.success(`Password reset for ${user.email}.`);
                  setNewPassword("");
                  setShowReset(false);
                } catch (err) {
                  const msg = err instanceof ApiError ? err.message : "Could not reset password";
                  setResetMessage(msg);
                  toast.error(msg);
                }
              }}
            >
              Set Password
            </button>
            {resetMessage && <p className="text-[10px] text-slate-500">{resetMessage}</p>}
          </div>
        )}
      </td>
    </tr>
  );
}
