pub mod auth;
pub mod create_meeting;
pub mod email_notifications;
pub mod google_calendar;
pub mod handler;
pub mod mail_delivery;
pub mod time;
pub mod zoom;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::create_meeting)
        .service(handler::create_meeting_link)
        .service(handler::get_meetings)
        .service(handler::update_meeting)
        .service(handler::delete_meeting);
}
