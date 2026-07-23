import Tasks, { type TasksConfig } from "../tasks/Tasks";
import {
  getTickets,
  createTicketApi,
  updateTicketApi,
  deleteTicketApi,
  aiFixTicket,
  listTicketAttachments,
  uploadTicketAttachments,
  deleteTicketAttachment,
  downloadTicketAttachment,
} from "../api/tickets";

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
    aiFix: aiFixTicket,
    listAttachments: listTicketAttachments,
    uploadAttachments: uploadTicketAttachments,
    deleteAttachment: deleteTicketAttachment,
    downloadAttachment: downloadTicketAttachment,
  },
  features: {
    attachments: true,
    statusSummary: true,
    aiFix: true,
  },
  storageKey: "tickets",
  // Clicking a ticket opens its own page (see TicketDetail) instead of a modal.
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
