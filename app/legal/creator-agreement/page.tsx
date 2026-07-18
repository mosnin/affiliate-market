export const metadata = {
  title: 'Creator Agreement | Cola',
  description: 'The agreement that governs creators and affiliates who promote software on Cola — how commissions are earned, the platform fee, payouts, and the FTC disclosure obligation.',
};

export default function CreatorAgreementPage() {
  return (
    <article className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Creator Agreement</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: June 13, 2026</p>
        <p className="text-sm text-muted-foreground">Effective: June 13, 2026</p>
      </header>

      <p className="text-sm leading-6 text-muted-foreground">
        This Creator Agreement (&quot;Agreement&quot;) governs your participation as a creator or affiliate on the Cola platform
        operated by Cola Inc. (&quot;Cola,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;). It applies when you grab a referral link from the
        explore page, promote a seller&apos;s software, and earn from sales you refer. By creating a referral link or otherwise
        participating in a seller&apos;s affiliate program through Cola, you agree to be bound by this Agreement, our{' '}
        <a href="/legal/terms" className="underline hover:text-foreground">Terms of Service</a>, and our{' '}
        <a href="/legal/acceptable-use" className="underline hover:text-foreground">Acceptable Use Policy</a>. If you do not
        agree, do not create a referral link.
      </p>

      {/* 1. Definitions */}
      <section>
        <h2 className="text-xl font-semibold">1. Definitions</h2>
        <ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground space-y-2 leading-6">
          <li><strong className="text-foreground">&quot;Creator&quot;</strong> (or &quot;Affiliate&quot;) means an individual or entity that grabs a referral link through Cola and promotes a Seller&apos;s software in exchange for commission on referred sales.</li>
          <li><strong className="text-foreground">&quot;Seller&quot;</strong> means the software company or developer that lists a product on Cola and sets the commission terms of its affiliate program.</li>
          <li><strong className="text-foreground">&quot;Referral Link&quot;</strong> means the unique tracking link minted for you from the explore page, carrying your referral code (<code className="text-foreground">?via=CODE</code>).</li>
          <li><strong className="text-foreground">&quot;Verified Sale&quot;</strong> means a purchase attributed to your Referral Link that has cleared payment and is not refunded, charged back, fraudulent, or otherwise reversed.</li>
          <li><strong className="text-foreground">&quot;Commission&quot;</strong> means the amount a Seller owes on a Verified Sale, stored as gross (what the Seller owes), the platform fee, and net (what you keep).</li>
          <li><strong className="text-foreground">&quot;Net Earnings&quot;</strong> means your Commission after the platform fee — the amount actually payable to you.</li>
          <li><strong className="text-foreground">&quot;Ledger&quot;</strong> means Cola&apos;s record of attributed sales, commissions, fees, clawbacks, and payouts. The Ledger is the system of record for what you are owed.</li>
        </ul>
      </section>

      {/* 2. Eligibility and Enrollment */}
      <section>
        <h2 className="text-xl font-semibold">2. Eligibility and Enrollment</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>2.1. You must be at least 18 years of age and able to form a binding contract to participate as a Creator.</p>
          <p>2.2. Grabbing a Referral Link enrolls you in the relevant Seller&apos;s affiliate program. Some Sellers approve applications manually; until a Seller approves you, your application is pending and no commission accrues.</p>
          <p>2.3. A Seller may set, change, or end the commission terms of its own program, and may approve or decline you at its discretion. Cola administers the program and the Ledger; the underlying commission rate is the Seller&apos;s.</p>
          <p>2.4. You are responsible for the accuracy of your account information and for any taxes owed on your Net Earnings. Cola does not withhold taxes and may require tax information before paying out.</p>
        </div>
      </section>

      {/* 3. How Commissions Are Earned */}
      <section>
        <h2 className="text-xl font-semibold">3. How Commissions Are Earned</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>3.1. <strong className="text-foreground">Per verified sale.</strong> You earn Commission only on Verified Sales attributed to your Referral Link. A click alone earns nothing; a sale that is later refunded, charged back, or found fraudulent is not a Verified Sale.</p>
          <p>3.2. <strong className="text-foreground">Attribution by cookie.</strong> When a buyer follows your Referral Link, Cola sets a <code className="text-foreground">cola_ref</code> cookie carrying your referral code. If that buyer checks out while the cookie is valid, the sale is attributed to you.</p>
          <p>3.3. <strong className="text-foreground">Attribution window.</strong> Attribution lasts for the duration of the attribution window measured from the buyer&apos;s click. If the window expires before checkout, the sale is not attributed to you.</p>
          <p>3.4. <strong className="text-foreground">Last-click.</strong> Where more than one Creator&apos;s code is present, the most recent qualifying click wins. The Creator whose link the buyer clicked last, within the window, earns the Commission.</p>
          <p>3.5. Commission accrues when a sale is verified and becomes payable through the payout process described in Section 5. Cola may hold newly accrued Commission for a reasonable settling period to allow for refunds and chargebacks before it is paid out.</p>
        </div>
      </section>

      {/* 4. Platform Fee and Net Earnings */}
      <section>
        <h2 className="text-xl font-semibold">4. Platform Fee and Net Earnings</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>4.1. <strong className="text-foreground">Flat 20% platform fee.</strong> Cola charges a flat platform fee of twenty percent (20%) of each Commission. You are paid the remaining eighty percent (80%) — your Net Earnings.</p>
          <p>4.2. <strong className="text-foreground">You are paid net.</strong> Every earnings figure Cola shows you is net — the amount you actually keep after the platform fee. You will never be shown a number you do not receive.</p>
          <p>4.3. The Ledger stores, for each Commission, the gross amount the Seller owes, the 20% platform fee, and your net. You can reconcile your Net Earnings against the Ledger at any time.</p>
          <p>4.4. The platform fee may change only with at least 30 days&apos; advance notice. A change applies to Commissions accrued after it takes effect, never retroactively.</p>
        </div>
      </section>

      {/* 5. Payouts */}
      <section>
        <h2 className="text-xl font-semibold">5. Payouts</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>5.1. <strong className="text-foreground">Stripe Connect.</strong> You connect your own Stripe account through Stripe Connect Express from your payouts page. Payout batches transfer your Net Earnings directly to your connected account.</p>
          <p>5.2. <strong className="text-foreground">Before you connect Stripe.</strong> Until you connect a Stripe account, your Net Earnings accrue on the Ledger and payouts queue for manual settlement. Connecting Stripe is the fastest way to get paid.</p>
          <p>5.3. Your use of Stripe is subject to Stripe&apos;s Connected Account Agreement and terms of service. Cola does not store your full bank or payment details.</p>
          <p>5.4. Cola may set a minimum payout threshold, a payout schedule, and a settling period before Commission becomes payable. Amounts below the threshold roll forward until met.</p>
          <p>5.5. You are responsible for keeping your Stripe and tax information current. Cola is not liable for payouts delayed or returned because your connected account is incomplete, restricted, or out of date.</p>
        </div>
      </section>

      {/* 6. Refunds, Chargebacks, and Clawback */}
      <section>
        <h2 className="text-xl font-semibold">6. Refunds, Chargebacks, and Clawback</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>6.1. <strong className="text-foreground">Commissions follow the sale.</strong> If a sale you were credited for is later refunded, charged back, reversed, or found to be fraudulent, the Commission on that sale is reversed. A reversed sale is not a Verified Sale.</p>
          <p>6.2. <strong className="text-foreground">Clawback.</strong> A reversal that lands after the Commission was already paid out creates a negative balance on your Ledger. Cola recovers that amount by offsetting it against your future Net Earnings until the balance is settled.</p>
          <p>6.3. If reversals exceed your accrued and future Net Earnings, or you stop earning before a negative balance is recovered, you remain responsible for the outstanding amount, and Cola may invoice you for it.</p>
          <p>6.4. Clawback protects Sellers and the integrity of the marketplace. It is not a penalty; it simply unwinds Commission on a sale that did not stand.</p>
        </div>
      </section>

      {/* 7. FTC Disclosure Obligation */}
      <section>
        <h2 className="text-xl font-semibold">7. FTC Disclosure Obligation</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>7.1. <strong className="text-foreground">You must disclose.</strong> When you promote a Seller&apos;s software through a Referral Link, you have a material connection to that Seller — you earn money on referred sales. United States Federal Trade Commission (FTC) guidance requires you to disclose that connection clearly and conspicuously, every time you promote.</p>
          <p>7.2. <strong className="text-foreground">How to disclose.</strong> Make the disclosure plain, in your own post, before the link, and easy to notice — not buried in a thread, hidden behind &quot;more,&quot; or stranded in a bio. A clear line such as <strong className="text-foreground">&quot;affiliate link&quot;</strong>, <strong className="text-foreground">&quot;#ad&quot;</strong>, or <strong className="text-foreground">&quot;I may earn a commission if you buy through my link&quot;</strong> satisfies this in most contexts. Match the disclosure to the platform you post on.</p>
          <p>7.3. <strong className="text-foreground">Honest claims.</strong> Only describe a product truthfully and from genuine experience. Do not invent results, fabricate reviews, or imply an endorsement you do not hold.</p>
          <p>7.4. <strong className="text-foreground">You are responsible.</strong> Compliance with the FTC&apos;s endorsement and disclosure rules — and any equivalent rules in your jurisdiction — is your responsibility as the person making the endorsement. Failure to disclose is a material breach of this Agreement and grounds for withheld Commission and termination.</p>
        </div>
      </section>

      {/* 8. Prohibited Conduct */}
      <section>
        <h2 className="text-xl font-semibold">8. Prohibited Conduct</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>8.1. You shall not:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong className="text-foreground">Self-refer.</strong> Use your own Referral Link to buy for yourself, or arrange purchases that route Commission back to you, your household, or accounts you control.</li>
            <li><strong className="text-foreground">Generate fraudulent clicks or sales.</strong> Use bots, click farms, incentivized clicks, cookie stuffing, forced clicks, or any scheme that manufactures attribution or sales that would not otherwise occur.</li>
            <li><strong className="text-foreground">Spam.</strong> Promote through unsolicited email, SMS, comment spam, or any channel that violates anti-spam law or a platform&apos;s rules.</li>
            <li><strong className="text-foreground">Misrepresent.</strong> Make false or misleading claims about a product, its price, its results, or your relationship to the Seller or to Cola, or pose as the Seller.</li>
            <li><strong className="text-foreground">Misuse brands.</strong> Bid on a Seller&apos;s trademarks, run deceptive lookalike domains, or use a Seller&apos;s or Cola&apos;s marks without permission.</li>
            <li><strong className="text-foreground">Omit disclosure.</strong> Promote without the clear and conspicuous disclosure required by Section 7.</li>
          </ul>
          <p>8.2. Commission earned through prohibited conduct is void and subject to clawback under Section 6. Cola may withhold disputed Commission while it investigates.</p>
        </div>
      </section>

      {/* 9. Relationship of the Parties */}
      <section>
        <h2 className="text-xl font-semibold">9. Relationship of the Parties</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>9.1. You are an independent party, not an employee, agent, or partner of Cola or of any Seller. Nothing in this Agreement creates a joint venture or employment relationship.</p>
          <p>9.2. You have no authority to make commitments on behalf of Cola or any Seller, to set prices, or to bind anyone to anything.</p>
          <p>9.3. You are responsible for your own content, channels, and the means by which you promote, and for complying with the terms of every platform you post on.</p>
        </div>
      </section>

      {/* 10. Commission Disputes */}
      <section>
        <h2 className="text-xl font-semibold">10. Commission Disputes</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>10.1. The Ledger is the system of record for attribution, Commission, fees, clawbacks, and payouts. If you believe an amount is wrong, write to <a href="mailto:creators@cola.app" className="underline hover:text-foreground">creators@cola.app</a> within 60 days of the entry.</p>
          <p>10.2. Cola will review the Ledger and the underlying attribution and resolve the question. Absent manifest error, Cola&apos;s determination from the Ledger is final. This keeps Seller↔Creator commission disputes from stalling payouts and is described further in the <a href="/legal/marketplace-terms" className="underline hover:text-foreground">Marketplace Terms</a>.</p>
        </div>
      </section>

      {/* 11. Term and Termination */}
      <section>
        <h2 className="text-xl font-semibold">11. Term and Termination</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>11.1. This Agreement applies for as long as you participate as a Creator. You may stop at any time; you simply stop using your Referral Links.</p>
          <p>11.2. Cola or a Seller may suspend or terminate your participation, deactivate your Referral Links, and withhold Commission if you breach this Agreement, engage in prohibited conduct, fail to disclose under Section 7, or act fraudulently or unlawfully.</p>
          <p>11.3. On termination, accrued Net Earnings on Verified Sales are paid out in the normal course, less any clawback or amount withheld for breach or investigation. Commission tied to prohibited conduct is forfeited.</p>
          <p>11.4. Sections 4, 6, 8, 10, and 11 survive termination.</p>
        </div>
      </section>

      {/* 12. Changes to this Agreement */}
      <section>
        <h2 className="text-xl font-semibold">12. Changes to this Agreement</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>12.1. We may modify this Agreement and will give notice of material changes by email or through the Service at least 30 days before they take effect.</p>
          <p>12.2. Continued participation as a Creator after the effective date constitutes acceptance of the revised Agreement. If you do not agree, stop using your Referral Links before the changes take effect.</p>
        </div>
      </section>

      {/* 13. Contact */}
      <section>
        <h2 className="text-xl font-semibold">13. Contact</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>Questions about this Creator Agreement:</p>
          <p>
            Cola Inc.<br />
            Email: <a href="mailto:creators@cola.app" className="underline hover:text-foreground">creators@cola.app</a><br />
            Website: <a href="https://usecola.com" className="underline hover:text-foreground">usecola.com</a>
          </p>
        </div>
      </section>

      {/* Summary / not legal advice footer */}
      <section className="border-t border-border/60 pt-6">
        <p className="text-xs text-muted-foreground leading-6">
          This page is a plain-language summary of the terms that govern creators on Cola. It is provided for convenience,
          is not legal advice, and does not create an attorney–client relationship. For advice about your specific
          situation — including your tax and FTC disclosure obligations — consult your own counsel.
        </p>
      </section>
    </article>
  );
}
