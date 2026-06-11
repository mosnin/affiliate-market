-- Feature 1: Recurring availability overrides
ALTER TABLE "DemoAvailabilityOverride"
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'none'
    CHECK (recurrence IN ('none', 'weekly', 'biweekly', 'monthly')),
  ADD COLUMN IF NOT EXISTS "endDate" date;

-- Feature 3: Multi-product scheduling profiles
CREATE TABLE IF NOT EXISTS "DemoProductProfile" (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"       text NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  name            text NOT NULL,
  address         text,
  "demoDuration"  integer NOT NULL DEFAULT 30,
  "startHour"     integer NOT NULL DEFAULT 9,
  "endHour"       integer NOT NULL DEFAULT 17,
  "daysAvailable" integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  "bufferMinutes" integer NOT NULL DEFAULT 0,
  "isActive"      boolean NOT NULL DEFAULT true,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_profile_space
  ON "DemoProductProfile" ("spaceId");

-- Link demos to a specific product profile
ALTER TABLE "Demo"
  ADD COLUMN IF NOT EXISTS "productProfileId" text REFERENCES "DemoProductProfile"(id) ON DELETE SET NULL;

-- Link overrides to a specific product profile
ALTER TABLE "DemoAvailabilityOverride"
  ADD COLUMN IF NOT EXISTS "productProfileId" text REFERENCES "DemoProductProfile"(id) ON DELETE CASCADE;

ALTER TABLE "DemoProductProfile" ENABLE ROW LEVEL SECURITY;
