// Display-only teams, shown when the org has no real ones yet, so the sidebar
// and the team page have something to show instead of an empty shell.
//
// Shared by Layout (the sidebar group) and TeamPage (which falls back to these
// when the backend has no row for the slug) so the two can't drift — a sample
// team in the sidebar has to lead somewhere.
//
// The team page shows the member list and nothing else, so tagline and
// description stay null; they exist only because the backend `Team` shape
// carries them.
//
// Ids are negative so they can never collide with a real backend row, and the
// addresses use example.com (reserved by RFC 2606) so nothing here can be
// mistaken for, or accidentally mailed to, a real person.

import type { Team } from "../api/workspace";

export type SampleMember = {
  name: string;
  role: string;
  email: string;
};

export type SampleTeam = Team & { members: SampleMember[] };

export const SAMPLE_TEAMS: SampleTeam[] = [
  {
    id: -1,
    name: "Engineering",
    slug: "engineering",
    tagline: null,
    description: null,
    members: [
      {
        name: "Priya Raghunathan",
        role: "Engineering Lead",
        email: "priya.raghunathan@example.com",
      },
      {
        name: "Tomás Okonkwo",
        role: "Backend Engineer",
        email: "tomas.okonkwo@example.com",
      },
      {
        name: "Marta Lindqvist",
        role: "Frontend Engineer",
        email: "marta.lindqvist@example.com",
      },
      {
        name: "Desmond Achebe",
        role: "Site Reliability Engineer",
        email: "desmond.achebe@example.com",
      },
    ],
  },
  {
    id: -2,
    name: "Design",
    slug: "design",
    tagline: null,
    description: null,
    members: [
      {
        name: "Ines Ferreira",
        role: "Design Lead",
        email: "ines.ferreira@example.com",
      },
      {
        name: "Kwame Boateng",
        role: "Product Designer",
        email: "kwame.boateng@example.com",
      },
      {
        name: "Yuki Tanabe",
        role: "Brand Designer",
        email: "yuki.tanabe@example.com",
      },
    ],
  },
  {
    id: -3,
    name: "Operations",
    slug: "operations",
    tagline: null,
    description: null,
    members: [
      {
        name: "Helena Marchetti",
        role: "Head of Operations",
        email: "helena.marchetti@example.com",
      },
      {
        name: "Rasmus Dahl",
        role: "Operations Manager",
        email: "rasmus.dahl@example.com",
      },
      {
        name: "Amara Diallo",
        role: "Workplace Coordinator",
        email: "amara.diallo@example.com",
      },
    ],
  },
  {
    id: -4,
    name: "Product",
    slug: "product",
    tagline: null,
    description: null,
    members: [
      {
        name: "Nadia Hollingsworth",
        role: "Head of Product",
        email: "nadia.hollingsworth@example.com",
      },
      {
        name: "Bruno Castellanos",
        role: "Product Manager",
        email: "bruno.castellanos@example.com",
      },
      {
        name: "Saoirse Mulvaney",
        role: "Technical Program Manager",
        email: "saoirse.mulvaney@example.com",
      },
    ],
  },
  {
    id: -5,
    name: "Marketing",
    slug: "marketing",
    tagline: null,
    description: null,
    members: [
      {
        name: "Oleksandr Voitenko",
        role: "Marketing Lead",
        email: "oleksandr.voitenko@example.com",
      },
      {
        name: "Fatima Zahra Bennani",
        role: "Content Strategist",
        email: "fatima.bennani@example.com",
      },
      {
        name: "Colin Fairweather",
        role: "Growth Marketer",
        email: "colin.fairweather@example.com",
      },
    ],
  },
  {
    id: -6,
    name: "Customer Success",
    slug: "customer-success",
    tagline: null,
    description: null,
    members: [
      {
        name: "Rosalind Achterberg",
        role: "Head of Customer Success",
        email: "rosalind.achterberg@example.com",
      },
      {
        name: "Ibrahim Al-Rashid",
        role: "Customer Success Manager",
        email: "ibrahim.alrashid@example.com",
      },
      {
        name: "Mei-Ling Chow",
        role: "Support Engineer",
        email: "meiling.chow@example.com",
      },
    ],
  },
  {
    id: -7,
    name: "Data & Analytics",
    slug: "data-analytics",
    tagline: null,
    description: null,
    members: [
      {
        name: "Anders Kirkegaard",
        role: "Analytics Lead",
        email: "anders.kirkegaard@example.com",
      },
      {
        name: "Chidinma Nwachukwu",
        role: "Data Engineer",
        email: "chidinma.nwachukwu@example.com",
      },
      {
        name: "Leonel Vasquez",
        role: "Data Analyst",
        email: "leonel.vasquez@example.com",
      },
    ],
  },
  {
    id: -8,
    name: "Finance",
    slug: "finance",
    tagline: null,
    description: null,
    members: [
      {
        name: "Guadalupe Herrera",
        role: "Finance Director",
        email: "guadalupe.herrera@example.com",
      },
      {
        name: "Piotr Zawadzki",
        role: "Financial Analyst",
        email: "piotr.zawadzki@example.com",
      },
      {
        name: "Thandiwe Mokoena",
        role: "Billing Specialist",
        email: "thandiwe.mokoena@example.com",
      },
    ],
  },
];

export function findSampleTeam(slug: string): SampleTeam | undefined {
  return SAMPLE_TEAMS.find((t) => t.slug === slug);
}
