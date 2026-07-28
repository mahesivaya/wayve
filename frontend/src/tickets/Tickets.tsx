import Tasks, { type TasksConfig } from "../tasks/Tasks";
import {
  getTickets,
  createTicketApi,
  updateTicketApi,
  deleteTicketApi,
  listTicketAttachments,
  uploadTicketAttachments,
  deleteTicketAttachment,
  downloadTicketAttachment,
} from "../api/tickets";
import { ticketAiFix } from "../api/aiFix";

// The Workspace "Tickets" board is the Tasks board with its own org-shared data
// source (separate from User Stories) and ticket-flavoured labels. Statuses,
// projects and assignable users are the same endpoints as Tasks (see
// api/tickets.ts); attachments are disabled because they are task-only
// server-side. This is NOT the "Help & Report issue" support-ticket flow.
const TICKETS_CONFIG: TasksConfig = {
  api: {
    list: getTickets,
    create: createTicketApi,
    update: updateTicketApi,
    remove: deleteTicketApi,
    aiFixPanel: ticketAiFix,
    listAttachments: listTicketAttachments,
    uploadAttachments: uploadTicketAttachments,
    deleteAttachment: deleteTicketAttachment,
    downloadAttachment: downloadTicketAttachment,
  },
  features: {
    attachments: true,
    statusSummary: true,
    // P4 (Low) and P5 (Lowest) tickets may be auto-fixed.
    aiFixMinPriority: 4,
    // Design (Figma) section is off on both boards now — file attachments cover
    // the same need without leaving the app. The ticket_figma_links table and
    // its endpoints stay, so flipping this back on restores existing links.
    figmaLinks: false,
    typeColumn: true,
  },
  storageKey: "tickets",
  // Name click opens the ticket in a right-side drawer; Edit (and deep links)
  // opens its full page (see TicketDetail).
  detailDrawer: true,
  detailPath: (id) => `/tickets/${id}`,
  labels: {
    title: "Tickets",
    subtitle: "A shared board of tickets for your workspace.",
    singular: "Ticket",
    lowerSingular: "ticket",
    lowerPlural: "tickets",
    createButton: "+ Create ticket",
    createTitle: "Create Ticket",
    editTitle: "Edit Ticket",
    namePlaceholder: "Ticket title",
    numberBadgeTooltip: "Ticket key",
    filtersTooltip: "Filter tickets",
    filtersAria: "Ticket filters",
  },
};

export default function Tickets() {
  return <Tasks config={TICKETS_CONFIG} />;
}
