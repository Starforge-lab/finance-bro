# Room instantiates WorkManager's generated database through reflection.
# https://android.googlesource.com/platform/frameworks/support/+/e4765e38e27a3f4d86188b996df97a52403dff46
-keep class * extends androidx.room.RoomDatabase { void <init>(); }
