import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { convex, api } from '@/lib/convex-server';
import { AuthorizeClient } from './authorize-client';

/**
 * GET /authorize — OAuth 2.0 Authorization Endpoint
 * Shows the user an approval screen. They must be logged in via Clerk.
 * After approval, redirects back to Claude with an authorization code.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    state?: string;
    scope?: string;
  }>;
}) {
  const params = await searchParams;
  const { userId } = await auth();

  // Must be logged in
  if (!userId) {
    // Redirect to login, then back here
    const currentUrl = `/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/login/seller?redirect_url=${encodeURIComponent(currentUrl)}`);
  }

  // Validate required params
  if (params.response_type !== 'code' || !params.client_id || !params.redirect_uri || !params.code_challenge) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3 p-8">
          <h1 className="text-xl font-semibold">Invalid Request</h1>
          <p className="text-sm text-muted-foreground">Missing required OAuth parameters.</p>
        </div>
      </div>
    );
  }

  // Validate client_id exists in our database
  const mcpKey = await convex().query(api.infra.mcpApiKeys.summaryByClientId, {
    clientId: params.client_id,
  });

  if (!mcpKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3 p-8">
          <h1 className="text-xl font-semibold">Unknown Application</h1>
          <p className="text-sm text-muted-foreground">The client ID is not recognized.</p>
        </div>
      </div>
    );
  }

  // Verify the user owns this space
  const user = await convex().query(api.org.users.getByClerkId, { clerkId: userId });

  const spaceRow = await convex().query(api.workspace.spaces.getById, { id: mcpKey.spaceId });
  // Enforce ownership exactly as the old `.eq('ownerId', user?.id ?? '')` filter:
  // an absent user (id '') never matches a real ownerId.
  const space = spaceRow && spaceRow.ownerId === (user?.id ?? '') ? spaceRow : null;

  if (!space) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3 p-8">
          <h1 className="text-xl font-semibold">Unauthorized</h1>
          <p className="text-sm text-muted-foreground">You don&apos;t own the workspace associated with this MCP key.</p>
        </div>
      </div>
    );
  }

  return (
    <AuthorizeClient
      spaceName={space.name}
      keyName={mcpKey.name}
      clientId={params.client_id}
      redirectUri={params.redirect_uri}
      codeChallenge={params.code_challenge}
      codeChallengeMethod={params.code_challenge_method ?? 'S256'}
      state={params.state ?? ''}
      scope={params.scope ?? ''}
    />
  );
}
