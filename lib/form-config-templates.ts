/**
 * Built-in form templates for the dynamic form builder.
 *
 * Four templates:
 *   1. Quote Request — full software purchase inquiry with role, team size, budget, timeline
 *   2. Demo Request — demo/trial lead capture with use-case and timeline
 *   3. Trial Signup — lightweight self-serve trial intake
 *   4. General Lead Capture — lightweight contact-only form
 */

import type { IntakeFormConfig } from '@/lib/form-config-schema';

export const RENTAL_APPLICATION_TEMPLATE: IntakeFormConfig = {
  version: 1,
  leadType: 'rental',
  sections: [
    {
      id: 'contact-info',
      title: 'Contact Information',
      description: 'Basic contact details for your quote request.',
      position: 0,
      questions: [
        {
          id: 'name',
          type: 'text',
          label: 'Full Name',
          placeholder: 'Jane Smith',
          required: true,
          position: 0,
          system: true,
          validation: { minLength: 1, maxLength: 120 },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Work Email',
          placeholder: 'jane@company.com',
          required: true,
          position: 1,
          system: true,
          validation: { maxLength: 255 },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          placeholder: '(555) 123-4567',
          required: true,
          position: 2,
          system: true,
          validation: { maxLength: 40 },
        },
        {
          id: 'company',
          type: 'text',
          label: 'Company Name',
          placeholder: 'Acme Corp',
          required: false,
          position: 3,
        },
      ],
    },
    {
      id: 'product-interest',
      title: 'Product Interest',
      description: 'Tell us about what you\'re looking for.',
      position: 1,
      questions: [
        {
          id: 'productInterest',
          type: 'text',
          label: 'Product / Plan',
          placeholder: 'e.g. Growth plan, API access',
          required: false,
          position: 0,
        },
        {
          id: 'targetMoveInDate',
          type: 'date',
          label: 'Target Start Date',
          required: false,
          position: 1,
        },
        {
          id: 'monthlyRent',
          type: 'select',
          label: 'Monthly Budget',
          required: false,
          position: 2,
          options: [
            { value: 'under_100', label: 'Under $100/mo' },
            { value: '100_500', label: '$100 - $500/mo' },
            { value: '500_1000', label: '$500 - $1,000/mo' },
            { value: '1000_2500', label: '$1,000 - $2,500/mo' },
            { value: '2500_5000', label: '$2,500 - $5,000/mo' },
            { value: '5000_plus', label: '$5,000+/mo' },
          ],
          scoring: { weight: 20 },
        },
        {
          id: 'numberOfOccupants',
          type: 'number',
          label: 'Team Size (seats)',
          required: false,
          position: 3,
          validation: { min: 1, max: 10000 },
        },
      ],
    },
    {
      id: 'role-authority',
      title: 'Role & Authority',
      description: 'Help us route your request to the right team.',
      position: 2,
      questions: [
        {
          id: 'employmentStatus',
          type: 'select',
          label: 'Your Role',
          required: false,
          position: 0,
          options: [
            { value: 'employed', label: 'Decision-maker / Budget owner', scoreValue: 10 },
            { value: 'self-employed', label: 'Founder / Solo operator', scoreValue: 8 },
            { value: 'part-time', label: 'Team lead / Manager', scoreValue: 7 },
            { value: 'student', label: 'Individual contributor', scoreValue: 4 },
            { value: 'retired', label: 'Consultant / Advisor', scoreValue: 6 },
            { value: 'unemployed', label: 'Evaluating for a client', scoreValue: 5 },
          ],
          scoring: {
            weight: 15,
            mappings: [
              { value: 'employed', points: 10 },
              { value: 'self-employed', points: 8 },
              { value: 'part-time', points: 7 },
              { value: 'student', points: 4 },
              { value: 'retired', points: 6 },
              { value: 'unemployed', points: 5 },
            ],
          },
        },
        {
          id: 'employerOrSource',
          type: 'text',
          label: 'Company / Organization',
          placeholder: 'Where will this be used?',
          required: false,
          position: 1,
          visibleWhen: { questionId: 'employmentStatus', operator: 'not_equals', value: 'unemployed' },
        },
        {
          id: 'monthlyGrossIncome',
          type: 'select',
          label: 'Annual Software Budget',
          required: false,
          position: 2,
          options: [
            { value: 'under_2000', label: 'Under $2,000/yr' },
            { value: '2000_3000', label: '$2,000 - $10,000/yr' },
            { value: '3000_4000', label: '$10,000 - $25,000/yr' },
            { value: '4000_5000', label: '$25,000 - $50,000/yr' },
            { value: '5000_7500', label: '$50,000 - $100,000/yr' },
            { value: '7500_plus', label: '$100,000+/yr' },
          ],
          scoring: { weight: 25 },
        },
      ],
    },
    {
      id: 'use-case',
      title: 'Use Case',
      description: 'A few quick questions to tailor your quote.',
      position: 3,
      questions: [
        {
          id: 'priorEvictions',
          type: 'radio',
          label: 'Do you have an existing tooling solution you\'d be replacing?',
          required: false,
          position: 0,
          options: [
            { value: 'no', label: 'No — greenfield adoption', scoreValue: 10 },
            { value: 'yes', label: 'Yes — switching from another tool', scoreValue: 7 },
          ],
          scoring: {
            weight: 15,
            mappings: [
              { value: 'no', points: 10 },
              { value: 'yes', points: 7 },
            ],
          },
        },
        {
          id: 'hasPets',
          type: 'radio',
          label: 'Are you currently using a competing product?',
          required: false,
          position: 1,
          options: [
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ],
        },
        {
          id: 'petDetails',
          type: 'textarea',
          label: 'Which product(s) are you currently using?',
          placeholder: 'e.g. HubSpot, Salesforce, custom build...',
          required: false,
          position: 2,
          visibleWhen: { questionId: 'hasPets', operator: 'equals', value: 'yes' },
        },
        {
          id: 'additionalNotes',
          type: 'textarea',
          label: 'Anything else you\'d like us to know?',
          placeholder: 'Use case, integrations needed, timeline...',
          required: false,
          position: 3,
          validation: { maxLength: 4000 },
        },
      ],
    },
  ],
};

export const BUYER_INQUIRY_TEMPLATE: IntakeFormConfig = {
  version: 1,
  leadType: 'buyer',
  sections: [
    {
      id: 'contact-info',
      title: 'Contact Information',
      position: 0,
      questions: [
        {
          id: 'name',
          type: 'text',
          label: 'Full Name',
          placeholder: 'Jane Smith',
          required: true,
          position: 0,
          system: true,
          validation: { minLength: 1, maxLength: 120 },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Work Email',
          placeholder: 'jane@company.com',
          required: true,
          position: 1,
          system: true,
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          placeholder: '(555) 987-6543',
          required: true,
          position: 2,
          system: true,
        },
      ],
    },
    {
      id: 'buyer-details',
      title: 'Demo Details',
      description: 'Help us tailor the demo to your needs.',
      position: 1,
      questions: [
        {
          id: 'buyerBudget',
          type: 'select',
          label: 'Monthly Budget',
          required: false,
          position: 0,
          options: [
            { value: 'under_200k', label: 'Under $200/mo' },
            { value: '200k_350k', label: '$200 - $500/mo' },
            { value: '350k_500k', label: '$500 - $1,000/mo' },
            { value: '500k_750k', label: '$1,000 - $2,500/mo' },
            { value: '750k_1m', label: '$2,500 - $5,000/mo' },
            { value: '1m_plus', label: '$5,000+/mo' },
          ],
          scoring: { weight: 20 },
        },
        {
          id: 'productType',
          type: 'select',
          label: 'Team Size',
          required: false,
          position: 1,
          options: [
            { value: 'single-family', label: 'Solo / 1 person' },
            { value: 'condo', label: '2-10 people' },
            { value: 'townhouse', label: '11-50 people' },
            { value: 'multi-family', label: '51-200 people' },
            { value: 'land', label: '200+ people' },
          ],
        },
        {
          id: 'bedrooms',
          type: 'select',
          label: 'Current Tooling',
          required: false,
          position: 2,
          options: [
            { value: '1', label: 'No existing tool' },
            { value: '2', label: 'Spreadsheets / manual' },
            { value: '3', label: 'Another SaaS product' },
            { value: '4', label: 'Custom / in-house build' },
            { value: '5+', label: 'Multiple tools' },
          ],
        },
        {
          id: 'buyerTimeline',
          type: 'select',
          label: 'When are you looking to get started?',
          required: false,
          position: 3,
          options: [
            { value: 'asap', label: 'As soon as possible', scoreValue: 10 },
            { value: '1-3mo', label: '1-3 months', scoreValue: 8 },
            { value: '3-6mo', label: '3-6 months', scoreValue: 5 },
            { value: 'exploring', label: 'Just exploring', scoreValue: 2 },
          ],
          scoring: {
            weight: 20,
            mappings: [
              { value: 'asap', points: 10 },
              { value: '1-3mo', points: 8 },
              { value: '3-6mo', points: 5 },
              { value: 'exploring', points: 2 },
            ],
          },
        },
      ],
    },
    {
      id: 'authority',
      title: 'Purchasing Authority',
      description: 'This helps us prioritize and prepare the right demo.',
      position: 2,
      questions: [
        {
          id: 'preApprovalStatus',
          type: 'radio',
          label: 'Are you the decision-maker for this purchase?',
          required: false,
          position: 0,
          options: [
            { value: 'yes', label: 'Yes — I can approve the purchase', scoreValue: 10 },
            { value: 'no', label: 'No — I\'ll need sign-off from others', scoreValue: 3 },
            { value: 'not-yet', label: 'Shared decision — I have strong influence', scoreValue: 6 },
          ],
          scoring: {
            weight: 25,
            mappings: [
              { value: 'yes', points: 10 },
              { value: 'no', points: 3 },
              { value: 'not-yet', points: 6 },
            ],
          },
        },
        {
          id: 'preApprovalLender',
          type: 'text',
          label: 'Who else is involved in the decision?',
          placeholder: 'e.g. CTO, CFO, procurement team',
          required: false,
          position: 1,
          visibleWhen: { questionId: 'preApprovalStatus', operator: 'equals', value: 'not-yet' },
        },
        {
          id: 'firstTimeBuyer',
          type: 'radio',
          label: 'First time evaluating this type of product?',
          required: false,
          position: 2,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
        },
        {
          id: 'additionalNotes',
          type: 'textarea',
          label: 'What are the top outcomes you want from this demo?',
          placeholder: 'e.g. See how affiliates are managed, understand pricing...',
          required: false,
          position: 3,
          validation: { maxLength: 4000 },
        },
      ],
    },
  ],
};

export const GENERAL_LEAD_CAPTURE_TEMPLATE: IntakeFormConfig = {
  version: 1,
  leadType: 'general',
  sections: [
    {
      id: 'contact-info',
      title: 'Get In Touch',
      description: 'We\'d love to hear from you.',
      position: 0,
      questions: [
        {
          id: 'name',
          type: 'text',
          label: 'Full Name',
          placeholder: 'Your name',
          required: true,
          position: 0,
          system: true,
          validation: { minLength: 1, maxLength: 120 },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email',
          placeholder: 'you@company.com',
          required: true,
          position: 1,
          system: true,
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone',
          placeholder: '(555) 000-0000',
          required: true,
          position: 2,
          system: true,
        },
        {
          id: 'interestedIn',
          type: 'select',
          label: 'I\'m interested in...',
          required: false,
          position: 3,
          options: [
            { value: 'buying', label: 'Purchasing a license' },
            { value: 'renting', label: 'Starting a trial' },
            { value: 'selling', label: 'Becoming an affiliate' },
            { value: 'other', label: 'Other' },
          ],
        },
        {
          id: 'additionalNotes',
          type: 'textarea',
          label: 'Message',
          placeholder: 'Tell us how we can help...',
          required: false,
          position: 4,
          validation: { maxLength: 4000 },
        },
      ],
    },
  ],
};

export const FORM_TEMPLATES = [
  {
    id: 'rental-application',
    name: 'Quote Request',
    description: 'Comprehensive purchase inquiry form with role, budget, team size, and use-case questions.',
    config: RENTAL_APPLICATION_TEMPLATE,
  },
  {
    id: 'buyer-inquiry',
    name: 'Demo Request',
    description: 'Demo lead capture with budget, team size, current tooling, and purchasing authority.',
    config: BUYER_INQUIRY_TEMPLATE,
  },
  {
    id: 'general-lead-capture',
    name: 'General Lead Capture',
    description: 'Lightweight contact form for quick lead generation.',
    config: GENERAL_LEAD_CAPTURE_TEMPLATE,
  },
];
