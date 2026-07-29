pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_user_stories)
        .service(handler::user_story_status_history)
        .service(handler::user_story_status_timeline)
        .service(handler::create_user_story)
        .service(handler::update_user_story)
        .service(handler::delete_user_story)
        // The AI-fix pipeline for stories. The handlers live in `tickets` beside
        // the ticket ones because both drive the identical `ai_fix_*` columns —
        // only the table, the visibility scope and the priority floor differ.
        .service(crate::tickets::handler::ai_fix_story)
        .service(crate::tickets::handler::get_story_ai_fix_state)
        .service(crate::tickets::handler::record_story_ai_fix_diff)
        .service(crate::tickets::handler::edit_story_ai_fix)
        .service(crate::tickets::handler::commit_story_ai_fix)
        .service(crate::tickets::handler::push_story_ai_fix)
        .service(crate::tickets::handler::open_story_ai_fix_pr);
}
