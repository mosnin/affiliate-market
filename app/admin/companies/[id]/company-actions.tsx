'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

// ── Toggle suspend/reactivate ────────────────────────────────────────────────

interface ToggleProps {
  action: 'toggle-status';
  companyId: string;
  currentStatus: string;
}

// ── Remove a member ──────────────────────────────────────────────────────────

interface RemoveMemberProps {
  action: 'remove-member';
  membershipId: string;
  label: string;
}

// ── Revoke an invitation ─────────────────────────────────────────────────────

interface RevokeInviteProps {
  action: 'revoke-invite';
  invitationId: string;
  label: string;
}

// ── Delete the company entirely ────────────────────────────────────────────

interface DeleteProps {
  action: 'delete';
  companyId: string;
  companyName: string;
}

type CompanyActionsProps = ToggleProps | RemoveMemberProps | RevokeInviteProps | DeleteProps;

export function CompanyActions(props: CompanyActionsProps) {
  const router = useRouter();

  if (props.action === 'toggle-status') {
    return <ToggleStatus {...props} onDone={() => router.refresh()} />;
  }
  if (props.action === 'remove-member') {
    return <RemoveMember {...props} onDone={() => router.refresh()} />;
  }
  if (props.action === 'revoke-invite') {
    return <RevokeInvite {...props} onDone={() => router.refresh()} />;
  }
  if (props.action === 'delete') {
    return <DeleteCompany {...props} />;
  }
  return null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ToggleStatus({
  companyId,
  currentStatus,
  onDone,
}: ToggleProps & { onDone: () => void }) {
  const [status, setStatus] = useState(currentStatus);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = status === 'active' ? 'suspended' : 'active';
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        setStatus(next);
        onDone();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={loading}
      className="w-full text-xs justify-start"
    >
      {loading ? '…' : status === 'active' ? 'Suspend company' : 'Reactivate company'}
    </Button>
  );
}

function RemoveMember({
  membershipId,
  label,
  onDone,
}: RemoveMemberProps & { onDone: () => void }) {
  const [loading, setLoading] = useState(false);

  async function remove() {
    if (!confirm(`Remove ${label} from this company?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/memberships/${membershipId}`, { method: 'DELETE' });
      if (res.ok) {
        onDone();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={remove}
      disabled={loading}
      className="text-xs text-destructive hover:text-destructive h-7 px-2"
    >
      {loading ? '…' : 'Remove'}
    </Button>
  );
}

function RevokeInvite({
  invitationId,
  label,
  onDone,
}: RevokeInviteProps & { onDone: () => void }) {
  const [loading, setLoading] = useState(false);

  async function revoke() {
    if (!confirm(`Revoke invitation to ${label}?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/invitations/${invitationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (res.ok) {
        onDone();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={revoke}
      disabled={loading}
      className="text-xs text-destructive hover:text-destructive h-7 px-2"
    >
      {loading ? '…' : 'Revoke'}
    </Button>
  );
}

function DeleteCompany({ companyId, companyName }: DeleteProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function deleteCompany() {
    if (
      !confirm(
        `Delete "${companyName}"?\n\nThis permanently removes all memberships and unlinks workspaces. This cannot be undone.`
      )
    )
      return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/admin/companies');
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={deleteCompany}
      disabled={loading}
      className="w-full text-xs justify-start border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      {loading ? '…' : 'Delete company'}
    </Button>
  );
}
