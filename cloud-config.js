// 云端地址填一次，两个人都省事。
// 在 Supabase 项目的 Settings → API 里抄这两项，填在这里存好，
// 之后不管在哪台设备打开这个 App，都直接连上，只需要登录。
// anon key 是公开可见的 key，安全靠登录 + RLS 白名单，不靠藏它。
window.CLOUD_DEFAULT = {
  url: '',   // 例：https://abcdefgh.supabase.co
  key: ''    // 例：eyJhbGciOi... （anon public）
};
