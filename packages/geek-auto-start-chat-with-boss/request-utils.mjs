export function requestPostDataOrEmpty(request) {
  try { return request?.postData?.() ?? '' } catch { return '' }
}
