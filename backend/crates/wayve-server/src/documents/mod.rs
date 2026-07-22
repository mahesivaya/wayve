pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    // The Documents ("library") page.
    mount(cfg, "/documents", "/document-folders");
    // The Skills page reuses the very same handlers over a second `collection`
    // ("skills") — the handlers pick their tree from the request path (see
    // `handler::collection_for`). Skills also exposes the read-only built-in
    // Claude skills catalog.
    mount(cfg, "/skills", "/skill-folders");
    cfg.route(
        "/skills/catalog",
        web::get().to(handler::list_skill_catalog),
    );
}

/// Wire one shared-workspace file tree under the given file + folder path bases.
fn mount(cfg: &mut web::ServiceConfig, files: &str, folders: &str) {
    cfg.route(files, web::get().to(handler::list_documents))
        .route(files, web::post().to(handler::upload_documents))
        .route(
            &format!("{files}/new"),
            web::post().to(handler::create_document),
        )
        .route(
            &format!("{files}/{{id}}/content"),
            web::get().to(handler::get_document_content),
        )
        .route(
            &format!("{files}/{{id}}/content"),
            web::put().to(handler::update_document_content),
        )
        .route(
            &format!("{files}/{{id}}/download"),
            web::get().to(handler::download_document),
        )
        .route(
            &format!("{files}/{{id}}"),
            web::patch().to(handler::rename_document),
        )
        .route(
            &format!("{files}/{{id}}"),
            web::delete().to(handler::delete_document),
        )
        .route(folders, web::get().to(handler::list_folders))
        .route(folders, web::post().to(handler::create_folder))
        .route(
            &format!("{folders}/{{id}}"),
            web::patch().to(handler::rename_folder),
        )
        .route(
            &format!("{folders}/{{id}}"),
            web::delete().to(handler::delete_folder),
        );
}
