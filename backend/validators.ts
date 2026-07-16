//All the following functions are unit tested

const validateFolderName = (name: unknown): boolean => {
  if (!name || typeof name !== 'string') return false
  if (name.length === 0) return false 
  if (name.length > 255) return false 
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) return false 
  if (name.includes('..')) return false  //prevent path traversal
  return true 
}

const validateUsername = (name: unknown): boolean => {
  if (!name || typeof name !== 'string') return false
  if (name.length === 0) return false
  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return false
  return true
}

const validateStoragePath = (name: unknown): boolean => {
  if (!name || typeof name !== 'string') return false
  if (!name.startsWith('/app/storage/')) return false
  if (name.includes('..')) return false
  return true
}

export {validateFolderName}
export {validateUsername}
export {validateStoragePath}