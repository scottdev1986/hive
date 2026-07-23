const std = @import("std");

pub fn deadline(output: []u8, additional_ms: u64) ![]const u8 {
    const now_ms = std.time.milliTimestamp();
    if (now_ms < 0) return error.InvalidTimestamp;
    const deadline_ms = std.math.add(u64, @intCast(now_ms), additional_ms) catch
        return error.InvalidTimestamp;
    const epoch_seconds: std.time.epoch.EpochSeconds = .{
        .secs = deadline_ms / std.time.ms_per_s,
    };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.bufPrint(output, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_seconds.getHoursIntoDay(),
        day_seconds.getMinutesIntoHour(),
        day_seconds.getSecondsIntoMinute(),
        deadline_ms % std.time.ms_per_s,
    });
}

pub fn parseMillis(value: []const u8) !u64 {
    if (value.len != 24 or value[4] != '-' or value[7] != '-' or value[10] != 'T' or
        value[13] != ':' or value[16] != ':' or value[19] != '.' or value[23] != 'Z')
        return error.InvalidTimestamp;
    const year = try std.fmt.parseInt(u64, value[0..4], 10);
    const month = try std.fmt.parseInt(u8, value[5..7], 10);
    const day = try std.fmt.parseInt(u8, value[8..10], 10);
    const hour = try std.fmt.parseInt(u8, value[11..13], 10);
    const minute = try std.fmt.parseInt(u8, value[14..16], 10);
    const second = try std.fmt.parseInt(u8, value[17..19], 10);
    const millisecond = try std.fmt.parseInt(u16, value[20..23], 10);
    if (year < 1970 or month == 0 or month > 12 or day == 0 or hour > 23 or
        minute > 59 or second > 59)
        return error.InvalidTimestamp;
    const leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
    const month_days = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day > month_days[month - 1]) return error.InvalidTimestamp;
    var days = (year - 1970) * 365 + leapYearsThrough(year - 1) - leapYearsThrough(1969);
    for (month_days[0 .. month - 1]) |count| days += count;
    days += day - 1;
    const seconds = try std.math.add(
        u64,
        try std.math.mul(u64, days, std.time.s_per_day),
        @as(u64, hour) * std.time.s_per_hour + @as(u64, minute) * std.time.s_per_min + second,
    );
    return std.math.add(
        u64,
        try std.math.mul(u64, seconds, std.time.ms_per_s),
        millisecond,
    );
}

pub fn expiryToMonotonic(value: []const u8, now_ns: u64, maximum_ms: u64) !u64 {
    const deadline_ms = try parseMillis(value);
    const wall_now = std.time.milliTimestamp();
    if (wall_now < 0 or deadline_ms <= @as(u64, @intCast(wall_now)))
        return error.Expired;
    const remaining_ms = deadline_ms - @as(u64, @intCast(wall_now));
    if (remaining_ms > maximum_ms) return error.InvalidTimestamp;
    return std.math.add(
        u64,
        now_ns,
        try std.math.mul(u64, remaining_ms, std.time.ns_per_ms),
    );
}

fn leapYearsThrough(year: u64) u64 {
    return year / 4 - year / 100 + year / 400;
}
