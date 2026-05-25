use chrono::NaiveTime;

pub fn minutes_to_time(mins: i32) -> NaiveTime {
    let h = mins / 60;
    let m = mins % 60;
    NaiveTime::from_hms_opt(h as u32, m as u32, 0).unwrap_or_default()
}
