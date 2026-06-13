export const metadata = {
  title: 'Marketplace Terms | Cola',
  description: 'The terms that govern sellers who list software on the Cola marketplace — listing accuracy, the marketplace fee and affiliate commission obligation, payouts, refunds, and commission-dispute resolution.',
};

export default function MarketplaceTermsPage() {
  return (
    <article className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Marketplace Terms</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: June 13, 2026</p>
        <p className="text-sm text-muted-foreground">Effective: June 13, 2026</p>
      </header>

      <p className="text-sm leading-6 text-muted-foreground">
        These Marketplace Terms (&quot;Marketplace Terms&quot;) govern your use of the Cola marketplace as a Seller — a software
        company or developer that lists a product for sale and runs an affiliate program through Cola Inc.
        (&quot;Cola,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;). They supplement our{' '}
        <a href="/legal/terms" className="underline hover:text-foreground">Terms of Service</a> and{' '}
        <a href="/legal/acceptable-use" className="underline hover:text-foreground">Acceptable Use Policy</a>; where a
        conflict concerns selling on the marketplace, these Marketplace Terms control. By listing a product or enabling an
        affiliate program on Cola, you agree to these Marketplace Terms.
      </p>

      {/* 1. Definitions */}
      <section>
        <h2 className="text-xl font-semibold">1. Definitions</h2>
        <ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground space-y-2 leading-6">
          <li><strong className="text-foreground">&quot;Seller&quot;</strong> means the software company or developer that lists a Product on the Cola marketplace and sets its affiliate program terms.</li>
          <li><strong className="text-foreground">&quot;Product&quot;</strong> means the software, license, or subscription a Seller lists for sale, together with its listing — description, pricing, media, and license terms.</li>
          <li><strong className="text-foreground">&quot;Buyer&quot;</strong> means a consumer who purchases a Product through the marketplace.</li>
          <li><strong className="text-foreground">&quot;Creator&quot;</strong> means an affiliate who promotes a Product through a referral link under the <a href="/legal/creator-agreement" className="underline hover:text-foreground">Creator Agreement</a>.</li>
          <li><strong className="text-foreground">&quot;Proceeds&quot;</strong> means the gross amount paid by Buyers for your Product, less the Marketplace Fee, refunds, the affiliate commission obligation, and applicable payment-processing costs.</li>
          <li><strong className="text-foreground">&quot;Commission&quot;</strong> means the amount you owe a Creator on a verified, attributed sale, recorded on the Ledger as gross.</li>
          <li><strong className="text-foreground">&quot;Ledger&quot;</strong> means Cola&apos;s record of marketplace sales, fees, commissions, refunds, clawbacks, and payouts — the system of record for amounts owed and paid.</li>
        </ul>
      </section>

      {/* 2. Listing Accuracy */}
      <section>
        <h2 className="text-xl font-semibold">2. Listing Accuracy</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>2.1. You are responsible for the accuracy of your listing — description, capabilities, pricing, license terms, system requirements, and media. Your listing must not be false, misleading, or deceptive.</p>
          <p>2.2. You must have the right to sell the Product and to license it to Buyers, including all rights to any code, content, and trademarks in the listing. You must not list a Product that infringes a third party&apos;s rights.</p>
          <p>2.3. You must honor the price and terms shown to a Buyer at the time of purchase. Price and term changes apply to future sales, not to completed ones.</p>
          <p>2.4. You must keep the listing current and correct known material defects or inaccuracies promptly. Cola may remove or suspend a listing that is inaccurate, infringing, or unlawful.</p>
        </div>
      </section>

      {/* 3. Marketplace Fee and Affiliate Commission Obligation */}
      <section>
        <h2 className="text-xl font-semibold">3. Marketplace Fee and Affiliate Commission Obligation</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>3.1. <strong className="text-foreground">Marketplace fee.</strong> Cola charges a marketplace fee on sales made through the marketplace, disclosed to you at the time you list. The marketplace fee is deducted from gross sales in computing your Proceeds.</p>
          <p>3.2. <strong className="text-foreground">You set the commission.</strong> You set the commission rate of your affiliate program. When a Creator refers a verified sale, you owe the Commission you set, recorded on the Ledger as gross — the full amount you owe before Cola&apos;s separate platform fee on the Creator&apos;s side.</p>
          <p>3.3. <strong className="text-foreground">Commission is your obligation.</strong> The Commission on an attributed sale is an amount you owe and Cola settles to the Creator out of the sale. By enabling an affiliate program, you authorize Cola to allocate and pay Commission on your verified, attributed sales from the Proceeds of those sales.</p>
          <p>3.4. Creators are always paid net of Cola&apos;s flat 20% platform fee, and Creators only ever see net figures. Your obligation is the gross Commission you set; how Cola splits its fee from the Creator&apos;s net does not change what you owe.</p>
        </div>
      </section>

      {/* 4. Payout of Proceeds */}
      <section>
        <h2 className="text-xl font-semibold">4. Payout of Proceeds</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>4.1. Cola pays out your Proceeds — gross sales less the Marketplace Fee, refunds, Commission obligations, and payment-processing costs — on the schedule and through the payment method configured for your workspace.</p>
          <p>4.2. <strong className="text-foreground">Seller money is gross.</strong> Figures shown to you are gross — what you are owed and what you owe — before the Creator-side split. The Ledger itemizes each sale&apos;s gross amount, Marketplace Fee, Commission, and net Proceeds.</p>
          <p>4.3. Cola may hold a reasonable reserve or settling period against refunds and chargebacks before releasing Proceeds, and may offset refunds, chargebacks, and reversed Commission against current and future Proceeds.</p>
          <p>4.4. Payment processing is handled by Stripe and is subject to Stripe&apos;s terms. You are responsible for the taxes owed on your Proceeds; Cola does not withhold them.</p>
        </div>
      </section>

      {/* 5. Refund Handling */}
      <section>
        <h2 className="text-xl font-semibold">5. Refund Handling</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>5.1. You set your Product&apos;s refund policy and must state it clearly in your listing. You are responsible for honoring it and for complying with any consumer-protection law that grants Buyers refund or cancellation rights.</p>
          <p>5.2. When a sale is refunded or charged back, the Marketplace Fee and the Commission on that sale are reversed, and the corresponding amounts are recovered from your Proceeds. Commission already paid to a Creator is clawed back under the <a href="/legal/creator-agreement" className="underline hover:text-foreground">Creator Agreement</a>.</p>
          <p>5.3. Excessive refunds or chargebacks may lead to a higher reserve, suspension of payouts, or removal from the marketplace.</p>
        </div>
      </section>

      {/* 6. Seller Responsibility for the Product */}
      <section>
        <h2 className="text-xl font-semibold">6. Seller Responsibility for the Product</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>6.1. The Product is yours. You are responsible for building, delivering, licensing, supporting, securing, and maintaining it, and for the license keys and any service you provide to Buyers.</p>
          <p>6.2. Cola is a marketplace and payments-and-attribution layer, not the seller of your Product, not its maker, and not a party to the license between you and the Buyer. Cola does not warrant your Product.</p>
          <p>6.3. You are responsible for Buyer support, warranty, and product-liability matters arising from your Product, and for complying with all laws applicable to selling and licensing software, including consumer-protection, export, and privacy law.</p>
          <p>6.4. You agree to indemnify Cola against claims arising from your Product, your listing, your refund practices, or your breach of these Marketplace Terms, as provided in the <a href="/legal/terms" className="underline hover:text-foreground">Terms of Service</a>.</p>
        </div>
      </section>

      {/* 7. Commission Disputes */}
      <section>
        <h2 className="text-xl font-semibold">7. Commission Disputes</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>7.1. <strong className="text-foreground">The Ledger governs.</strong> Attribution, Commission, fees, refunds, clawbacks, and payouts are recorded on the Ledger. The Ledger is the single system of record for any dispute between a Seller and a Creator about whether Commission is owed on a sale and how much.</p>
          <p>7.2. <strong className="text-foreground">How disputes are handled.</strong> If you dispute a Commission — for example, you believe a sale was not genuinely referred, was self-referred, or was reversed — raise it with <a href="mailto:sellers@cola.app" className="underline hover:text-foreground">sellers@cola.app</a> within 60 days of the Ledger entry. Cola will review the Ledger and the underlying attribution and decide the question.</p>
          <p>7.3. <strong className="text-foreground">Cola&apos;s determination is final absent manifest error.</strong> To keep payouts moving, Cola&apos;s determination from the Ledger is final and binding on both the Seller and the Creator, except in the case of manifest error (a plain, demonstrable mistake in the record or its calculation). Cola may withhold a disputed Commission while it investigates.</p>
          <p>7.4. This Section governs commission-attribution disputes between a Seller and a Creator. It does not limit either party&apos;s separate rights against Cola under the <a href="/legal/terms" className="underline hover:text-foreground">Terms of Service</a>.</p>
        </div>
      </section>

      {/* 8. Suspension and Removal */}
      <section>
        <h2 className="text-xl font-semibold">8. Suspension and Removal</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>8.1. Cola may suspend or remove a listing, pause an affiliate program, or hold payouts if a Seller breaches these Marketplace Terms, lists an inaccurate or infringing Product, generates excessive refunds or chargebacks, or acts unlawfully.</p>
          <p>8.2. On removal, Cola settles outstanding verified Proceeds and Commission obligations in the normal course, net of reserves, refunds, and reversals.</p>
          <p>8.3. Sections 3, 5, 6, and 7 survive removal of a listing or termination of a Seller&apos;s use of the marketplace.</p>
        </div>
      </section>

      {/* 9. Changes to these Terms */}
      <section>
        <h2 className="text-xl font-semibold">9. Changes to these Terms</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>9.1. We may modify these Marketplace Terms and will give notice of material changes by email or through the Service at least 30 days before they take effect.</p>
          <p>9.2. Continued listing or selling after the effective date constitutes acceptance of the revised Marketplace Terms.</p>
        </div>
      </section>

      {/* 10. Contact */}
      <section>
        <h2 className="text-xl font-semibold">10. Contact</h2>
        <div className="mt-3 text-sm text-muted-foreground space-y-3 leading-6">
          <p>Questions about these Marketplace Terms:</p>
          <p>
            Cola Inc.<br />
            Email: <a href="mailto:sellers@cola.app" className="underline hover:text-foreground">sellers@cola.app</a><br />
            Website: <a href="https://usecola.com" className="underline hover:text-foreground">usecola.com</a>
          </p>
        </div>
      </section>

      {/* Summary / not legal advice footer */}
      <section className="border-t border-border/60 pt-6">
        <p className="text-xs text-muted-foreground leading-6">
          This page is a plain-language summary of the terms that govern sellers on the Cola marketplace. It is provided
          for convenience, is not legal advice, and does not create an attorney–client relationship. For advice about your
          specific situation, consult your own counsel.
        </p>
      </section>
    </article>
  );
}
