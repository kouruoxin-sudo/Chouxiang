// 云端地址填一次，两个人都省事。
// 在 Supabase 项目的 Settings → API 里抄这两项，填在这里存好，
// 之后不管在哪台设备打开这个 App，都直接连上，只需要登录。
// anon key 是公开可见的 key，安全靠登录 + RLS 白名单，不靠藏它。
window.CLOUD_DEFAULT = {
  url: 'https://ansgumwaptwwgkghdckn.supabase.co',   // 例：https://abcdefgh.supabase.co
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuc2d1bXdhcHR3d2drZ2hkY2tuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNzU1MTMsImV4cCI6MjEwMzk1MTUxM30.p1TNjaltDbuvkKLa8_9usxmRYaq1ECY0VtiolGJ8fzY'    // 例：eyJhbGciOi... （anon public）
};
