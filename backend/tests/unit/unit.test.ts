import {expect, test} from 'vitest'
import {validateFolderName, validateUsername, validateStoragePath} from '../../validators'


test('validate the folder name input', () => {
    expect(validateFolderName('folder')).toBe(true)
    expect(validateFolderName(13)).toBe(false)
    expect(validateFolderName('')).toBe(false)
    expect(validateFolderName('a'.repeat(254))).toBe(true)
    expect(validateFolderName('a'.repeat(256))).toBe(false)
    expect(validateFolderName('../pathTraversal')).toBe(false)
})

test('validate the username', () => {
    expect(validateUsername(13)).toBe(false)
    expect(validateUsername('')).toBe(false)
    expect(validateUsername('Jane')).toBe(true)
})

test('validate the storage path', () => {
    expect(validateStoragePath(13)).toBe(false)
    expect(validateStoragePath('')).toBe(false)
    expect(validateStoragePath('/app/storage/..')).toBe(false)
    expect(validateStoragePath('/app/storage/username')).toBe(true)
})