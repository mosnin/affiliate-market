import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { getSpaceForUser } from '@/lib/space';
import { audit } from '@/lib/audit';
import { isValidSlug, normalizeSlug } from '@/lib/intake';
import type { SpaceSetting } from '@/lib/types';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 });

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.slug !== slug) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [settingsRow, owner] = await Promise.all([
    convex().query(api.workspace.settings.getBySpace, { spaceId: userSpace.id }),
    convex().query(api.org.users.getById, { id: userSpace.ownerId }),
  ]);
  // getBySpace returns the full mapped SpaceSetting row (a superset of the columns
  // this route reads); the `??` fallbacks below still handle nulls.
  const settings = settingsRow as (Partial<SpaceSetting> & {
    logoUrl?: string | null;
    sellerPhotoUrl?: string | null;
  }) | null;

  return NextResponse.json({
    settings: {
      // Notification settings
      notifications: settings?.notifications ?? true,
      smsNotifications: settings?.smsNotifications ?? false,
      notifyNewLeads: settings?.notifyNewLeads ?? true,
      notifyDemoBookings: settings?.notifyDemoBookings ?? true,
      notifyNewDeals: settings?.notifyNewDeals ?? true,
      notifyFollowUps: settings?.notifyFollowUps ?? true,
      phoneNumber: settings?.phoneNumber ?? '',
      timezone: settings?.timezone ?? 'America/New_York',
      // Daily brief settings (Phase B3 / B6)
      briefEnabled: settings?.briefEnabled ?? true,
      briefHour: settings?.briefHour ?? 7,
      briefEmail: settings?.briefEmail ?? false,
      briefSms: settings?.briefSms ?? false,
      myConnections: settings?.myConnections ?? '',
      // Profile settings
      bio: settings?.bio ?? '',
      socialLinks: settings?.socialLinks ?? { instagram: '', linkedin: '', facebook: '' },
      businessName: settings?.businessName ?? '',
      sellerPhotoUrl: settings?.sellerPhotoUrl ?? '',
      privacyPolicyHtml: settings?.privacyPolicyHtml ?? '',
      // Appearance settings
      intakeAccentColor: settings?.intakeAccentColor ?? '#34c77f',
      intakeBorderRadius: settings?.intakeBorderRadius ?? 'rounded',
      intakeFont: settings?.intakeFont ?? 'system',
      intakeDarkMode: settings?.intakeDarkMode ?? false,
      intakeHeaderBgColor: settings?.intakeHeaderBgColor ?? '',
      intakeHeaderGradient: settings?.intakeHeaderGradient ?? '',
      intakeFaviconUrl: settings?.intakeFaviconUrl ?? '',
      logoUrl: settings?.logoUrl ?? '',
      // Content settings
      intakePageTitle: settings?.intakePageTitle ?? 'Rental Application',
      intakePageIntro: settings?.intakePageIntro ?? '',
      intakeVideoUrl: settings?.intakeVideoUrl ?? '',
      intakeThankYouTitle: settings?.intakeThankYouTitle ?? '',
      intakeThankYouMessage: settings?.intakeThankYouMessage ?? '',
      intakeConfirmationEmail: settings?.intakeConfirmationEmail ?? '',
      intakeDisclaimerText: settings?.intakeDisclaimerText ?? '',
      intakeFooterLinks: settings?.intakeFooterLinks ?? [],
    },
    ownerEmail: owner?.email ?? '',
  });
}

export async function PATCH(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const {
    slug,
    emoji,
    notifications,
    smsNotifications,
    notifyNewLeads,
    notifyDemoBookings,
    notifyNewDeals,
    notifyFollowUps,
    briefEnabled,
    briefHour,
    briefEmail,
    briefSms,
  } = body;

  // Sanitize and cap all free-text fields to prevent storage DoS and injection
  // name: use undefined when absent so we can skip it; empty string is a valid (cleared) name
  const name            = typeof body.name            === 'string' ? body.name.slice(0, 100)            : undefined;
  // phoneNumber: use undefined (not null) when absent so we can skip it in the upsert
  const phoneNumber     = typeof body.phoneNumber     === 'string' ? body.phoneNumber.slice(0, 50)       : undefined;
  const myConnections   = typeof body.myConnections   === 'string' ? body.myConnections.slice(0, 500)    : undefined;
  const aiPersonalization = typeof body.aiPersonalization === 'string' ? body.aiPersonalization.slice(0, 1000) : undefined;
  const billingSettings = typeof body.billingSettings === 'string' ? body.billingSettings.slice(0, 2000) : undefined;
  const bio             = typeof body.bio             === 'string' ? body.bio.slice(0, 500)             : undefined;
  const socialLinks     = body.socialLinks && typeof body.socialLinks === 'object' ? body.socialLinks    : undefined;
  const logoUrl         = typeof body.logoUrl         === 'string' ? body.logoUrl.slice(0, 500)         : undefined;
  const sellerPhotoUrl = typeof body.sellerPhotoUrl === 'string' ? body.sellerPhotoUrl.slice(0, 500)  : undefined;
  const businessName    = typeof body.businessName    === 'string' ? body.businessName.slice(0, 200)     : undefined;
  // Appearance fields
  const intakeAccentColor    = typeof body.intakeAccentColor    === 'string' ? body.intakeAccentColor.slice(0, 50)    : undefined;
  const intakeBorderRadius   = body.intakeBorderRadius === 'rounded' || body.intakeBorderRadius === 'sharp' ? body.intakeBorderRadius : undefined;
  const intakeFont           = body.intakeFont === 'system' || body.intakeFont === 'serif' || body.intakeFont === 'mono' ? body.intakeFont : undefined;
  const intakeDarkMode       = typeof body.intakeDarkMode === 'boolean' ? body.intakeDarkMode : undefined;
  const intakeHeaderBgColor  = typeof body.intakeHeaderBgColor  === 'string' ? body.intakeHeaderBgColor.slice(0, 100)  : (body.intakeHeaderBgColor === null ? null : undefined);
  const intakeHeaderGradient = typeof body.intakeHeaderGradient === 'string' ? body.intakeHeaderGradient.slice(0, 200) : (body.intakeHeaderGradient === null ? null : undefined);
  const intakeFaviconUrl     = typeof body.intakeFaviconUrl     === 'string' ? body.intakeFaviconUrl.slice(0, 500)     : (body.intakeFaviconUrl === null ? null : undefined);
  // Content fields
  const intakePageTitle         = typeof body.intakePageTitle         === 'string' ? body.intakePageTitle.slice(0, 200)         : undefined;
  const intakePageIntro         = typeof body.intakePageIntro         === 'string' ? body.intakePageIntro.slice(0, 500)         : undefined;
  const intakeVideoUrl          = typeof body.intakeVideoUrl          === 'string' ? body.intakeVideoUrl.slice(0, 500)          : (body.intakeVideoUrl === null ? null : undefined);
  const intakeThankYouTitle     = typeof body.intakeThankYouTitle     === 'string' ? body.intakeThankYouTitle.slice(0, 200)     : (body.intakeThankYouTitle === null ? null : undefined);
  const intakeThankYouMessage   = typeof body.intakeThankYouMessage   === 'string' ? body.intakeThankYouMessage.slice(0, 2000)  : (body.intakeThankYouMessage === null ? null : undefined);
  const intakeConfirmationEmail = typeof body.intakeConfirmationEmail === 'string' ? body.intakeConfirmationEmail.slice(0, 5000) : (body.intakeConfirmationEmail === null ? null : undefined);
  const intakeDisclaimerText    = typeof body.intakeDisclaimerText    === 'string' ? body.intakeDisclaimerText.slice(0, 2000)   : (body.intakeDisclaimerText === null ? null : undefined);
  const intakeFooterLinks       = Array.isArray(body.intakeFooterLinks) ? body.intakeFooterLinks : undefined;
  // Trust signals — three optional compliance slots rendered in the intake footer.
  // License number: short identifier; cap conservatively. Fair housing notice:
  // multi-line text; cap at 2KB. Mark: boolean.
  const intakeLicenseNumber         = typeof body.intakeLicenseNumber === 'string' ? body.intakeLicenseNumber.trim().slice(0, 200) : (body.intakeLicenseNumber === null ? null : undefined);
  const intakeFairHousingNotice     = typeof body.intakeFairHousingNotice === 'string' ? body.intakeFairHousingNotice.slice(0, 2000) : (body.intakeFairHousingNotice === null ? null : undefined);
  const intakeShowEqualHousingMark  = typeof body.intakeShowEqualHousingMark === 'boolean' ? body.intakeShowEqualHousingMark : undefined;

  // Legal & compliance fields
  const rawPrivacyPolicyUrl = typeof body.privacyPolicyUrl === 'string' ? body.privacyPolicyUrl.trim().slice(0, 500) : undefined;
  const consentCheckboxLabel = typeof body.consentCheckboxLabel === 'string' ? body.consentCheckboxLabel.trim().slice(0, 500) : undefined;
  // Privacy Policy HTML (rich text content, capped at 100KB)
  const privacyPolicyHtml = body.privacyPolicyHtml !== undefined
    ? (typeof body.privacyPolicyHtml === 'string' ? body.privacyPolicyHtml.slice(0, 100_000) : null)
    : undefined;

  // Validate privacy policy URL if provided
  if (rawPrivacyPolicyUrl !== undefined && rawPrivacyPolicyUrl !== null && rawPrivacyPolicyUrl !== '') {
    try {
      const purl = new URL(rawPrivacyPolicyUrl);
      if (purl.protocol !== 'https:') {
        return NextResponse.json({ error: 'Privacy policy URL must use HTTPS' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Privacy policy URL is not a valid URL' }, { status: 400 });
    }
  }

  let space;
  try {
    space = await convex().query(api.workspace.spaces.getBySlug, { slug: slug as string });
  } catch (spaceError) {
    console.error('[PATCH /api/spaces] Space lookup error:', spaceError);
    return NextResponse.json({ error: "Database hiccup — usually temporary." }, { status: 500 });
  }
  if (!space) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || space.id !== userSpace.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const updateFields: Record<string, unknown> = {};
  if (name !== undefined) updateFields.name = name;
  if (emoji !== undefined) updateFields.emoji = emoji;
  if (body.companyId && typeof body.companyId === 'string') {
    // SECURITY: only allow associating with a company the owner is actually a
    // member of. companyId drives credit-pool routing (lib/billing/account.ts);
    // accepting an arbitrary value would let a user point their space at any
    // company's billing pool.
    const membership = await convex().query(api.org.memberships.getByCompanyUser, {
      companyId: body.companyId,
      userId: space.ownerId,
    });
    if (membership) updateFields.companyId = body.companyId;
  }

  // Handle slug change
  const rawNewSlug = typeof body.newSlug === 'string' ? body.newSlug.trim() : '';
  if (rawNewSlug && rawNewSlug !== slug) {
    const sanitized = normalizeSlug(rawNewSlug);
    if (!isValidSlug(sanitized) || sanitized !== rawNewSlug) {
      return NextResponse.json({ error: 'Only lowercase letters, numbers, and hyphens allowed (min 3 chars)' }, { status: 400 });
    }
    // Check uniqueness
    const existing = await convex().query(api.workspace.spaces.getBySlug, { slug: sanitized });
    if (existing) {
      return NextResponse.json({ error: 'That slug is already taken' }, { status: 409 });
    }
    updateFields.slug = sanitized;
  }

  let updatedSpace: { id: string; slug: string; name: string; emoji: string | null; createdAt: string; ownerId: string };
  if (Object.keys(updateFields).length > 0) {
    let updated;
    try {
      updated = await convex().mutation(api.workspace.spaces.updateBySlug, {
        slug: slug as string,
        fields: updateFields,
      });
    } catch (updateError) {
      console.error('[PATCH /api/spaces] Space update error:', updateError);
      return NextResponse.json({ error: "Database hiccup — usually temporary." }, { status: 500 });
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    updatedSpace = updated;
  } else {
    updatedSpace = space;
  }

  // Only include fields that were actually provided in the request body
  // to prevent partial saves (e.g., notifications page) from wiping out
  // fields managed by other forms (e.g., phone number from general settings).
  // id/spaceId are owned by the mutation (id minted on insert, spaceId is the
  // key), so the payload carries the writable fields only.
  const settingsFields: Record<string, unknown> = {};
  if (typeof notifications === 'boolean') settingsFields.notifications = notifications;
  if (typeof smsNotifications === 'boolean') settingsFields.smsNotifications = smsNotifications;
  if (typeof notifyNewLeads === 'boolean') settingsFields.notifyNewLeads = notifyNewLeads;
  if (typeof notifyDemoBookings === 'boolean') settingsFields.notifyDemoBookings = notifyDemoBookings;
  if (typeof notifyNewDeals === 'boolean') settingsFields.notifyNewDeals = notifyNewDeals;
  if (typeof notifyFollowUps === 'boolean') settingsFields.notifyFollowUps = notifyFollowUps;
  if (typeof briefEnabled === 'boolean') settingsFields.briefEnabled = briefEnabled;
  // briefHour: integer 0-23 in the space's timezone. Reject malformed
  // values silently so a typo'd payload doesn't write garbage.
  if (typeof briefHour === 'number' && Number.isInteger(briefHour) && briefHour >= 0 && briefHour <= 23) {
    settingsFields.briefHour = briefHour;
  }
  if (typeof briefEmail === 'boolean') settingsFields.briefEmail = briefEmail;
  if (typeof briefSms === 'boolean') settingsFields.briefSms = briefSms;
  if (phoneNumber !== undefined) settingsFields.phoneNumber = phoneNumber;
  if (myConnections !== undefined) settingsFields.myConnections = myConnections;
  if (aiPersonalization !== undefined) settingsFields.aiPersonalization = aiPersonalization;
  if (billingSettings !== undefined) settingsFields.billingSettings = billingSettings;
  if (bio !== undefined) settingsFields.bio = bio;
  if (socialLinks !== undefined) settingsFields.socialLinks = socialLinks;
  if (logoUrl !== undefined) settingsFields.logoUrl = logoUrl;
  if (sellerPhotoUrl !== undefined) settingsFields.sellerPhotoUrl = sellerPhotoUrl;
  if (businessName !== undefined) settingsFields.businessName = businessName;
  if (rawPrivacyPolicyUrl !== undefined) settingsFields.privacyPolicyUrl = rawPrivacyPolicyUrl || null;
  if (consentCheckboxLabel !== undefined) settingsFields.consentCheckboxLabel = consentCheckboxLabel || null;
  if (privacyPolicyHtml !== undefined) settingsFields.privacyPolicyHtml = privacyPolicyHtml || null;
  // Appearance fields
  if (intakeAccentColor !== undefined) settingsFields.intakeAccentColor = intakeAccentColor;
  if (intakeBorderRadius !== undefined) settingsFields.intakeBorderRadius = intakeBorderRadius;
  if (intakeFont !== undefined) settingsFields.intakeFont = intakeFont;
  if (intakeDarkMode !== undefined) settingsFields.intakeDarkMode = intakeDarkMode;
  if (intakeHeaderBgColor !== undefined) settingsFields.intakeHeaderBgColor = intakeHeaderBgColor;
  if (intakeHeaderGradient !== undefined) settingsFields.intakeHeaderGradient = intakeHeaderGradient;
  if (intakeFaviconUrl !== undefined) settingsFields.intakeFaviconUrl = intakeFaviconUrl;
  // Content fields
  if (intakePageTitle !== undefined) settingsFields.intakePageTitle = intakePageTitle;
  if (intakePageIntro !== undefined) settingsFields.intakePageIntro = intakePageIntro;
  if (intakeVideoUrl !== undefined) settingsFields.intakeVideoUrl = intakeVideoUrl;
  if (intakeThankYouTitle !== undefined) settingsFields.intakeThankYouTitle = intakeThankYouTitle;
  if (intakeThankYouMessage !== undefined) settingsFields.intakeThankYouMessage = intakeThankYouMessage;
  if (intakeConfirmationEmail !== undefined) settingsFields.intakeConfirmationEmail = intakeConfirmationEmail;
  if (intakeDisclaimerText !== undefined) settingsFields.intakeDisclaimerText = intakeDisclaimerText;
  if (intakeFooterLinks !== undefined) settingsFields.intakeFooterLinks = intakeFooterLinks;
  // Trust signals
  if (intakeLicenseNumber !== undefined) settingsFields.intakeLicenseNumber = intakeLicenseNumber || null;
  if (intakeFairHousingNotice !== undefined) settingsFields.intakeFairHousingNotice = intakeFairHousingNotice || null;
  if (intakeShowEqualHousingMark !== undefined) settingsFields.intakeShowEqualHousingMark = intakeShowEqualHousingMark;

  // Demo availability settings
  if (typeof body.demoDuration === 'number' && [15, 30, 45, 60, 90, 120].includes(body.demoDuration)) {
    settingsFields.demoDuration = body.demoDuration;
  }
  if (typeof body.demoBufferMinutes === 'number' && [0, 15, 30, 45, 60].includes(body.demoBufferMinutes)) {
    settingsFields.demoBufferMinutes = body.demoBufferMinutes;
  }
  if (typeof body.demoStartHour === 'number' && body.demoStartHour >= 0 && body.demoStartHour <= 23) {
    settingsFields.demoStartHour = body.demoStartHour;
  }
  if (typeof body.demoEndHour === 'number' && body.demoEndHour >= 1 && body.demoEndHour <= 24) {
    settingsFields.demoEndHour = body.demoEndHour;
  }
  if (Array.isArray(body.demoDaysAvailable)) {
    const validDays = body.demoDaysAvailable.filter((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6);
    settingsFields.demoDaysAvailable = validDays;
  }
  if (Array.isArray(body.demoBlockedDates)) {
    const validDates = body.demoBlockedDates.filter((d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d as string));
    settingsFields.demoBlockedDates = validDates;
  }

  try {
    await convex().mutation(api.workspace.settings.upsertBySpace, {
      spaceId: space.id,
      fields: settingsFields,
    });
  } catch (settingsError) {
    console.error('[PATCH /api/spaces] Settings upsert error:', settingsError);
    return NextResponse.json({ error: "Couldn't save settings — usually temporary." }, { status: 500 });
  }

  void audit({ actorClerkId: userId, action: 'UPDATE', resource: 'Space', resourceId: space.id, spaceId: space.id, req, metadata: updatedSpace.slug !== slug ? { oldSlug: slug, newSlug: updatedSpace.slug } : undefined });

  return NextResponse.json(updatedSpace);
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let slug: string;
  try {
    const body = await req.json();
    slug = body.slug;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 });

  let space;
  try {
    space = await convex().query(api.workspace.spaces.getBySlug, { slug });
  } catch (spaceError) {
    console.error('[DELETE /api/spaces] Space lookup error:', spaceError);
    return NextResponse.json({ error: "Database hiccup — usually temporary." }, { status: 500 });
  }
  if (!space) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || space.id !== userSpace.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Audit BEFORE delete so we still have the spaceId in the log
  void audit({
    actorClerkId: userId,
    action: 'DELETE',
    resource: 'Space',
    resourceId: space.id,
    spaceId: space.id,
    req,
    metadata: { slug: space.slug, name: space.name },
  });

  // removeBySlug deletes the Space + its within-domain children (SpaceSetting,
  // DisabledSpace) and purges the space's credit rows. NOTE: the full cross-
  // domain space-scoped cascade (Contact/Deal/Conversation/…, which Postgres did
  // via FK ON DELETE CASCADE) is the shared purgeSpaceData follow-up tracked in
  // lib/account-deletion.ts — Convex has no FK cascade.
  try {
    const { deleted } = await convex().mutation(api.workspace.spaces.removeBySlug, { slug });
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (deleteError) {
    console.error('[DELETE /api/spaces] Delete error:', deleteError);
    return NextResponse.json({ error: "Couldn't delete workspace — usually temporary." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
