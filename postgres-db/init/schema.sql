--USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

--FOLDERS
CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  parent_folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE, --null on main user folder
  path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

--FILES
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size BIGINT NOT NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  mime_type VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  thumbnail_path VARCHAR(500) DEFAULT NULL
);

--TODO: soft delete
--deleted_at TIMESTAMP DEFAULT NULL  (NULL = not deleted, NOW() = deleted)


--REFRESH TOKENS
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

--Indexes
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);


--TRIGGER TO AUTO-UPDATE THE updated_at COLUMN WHEN files ARE UPDATED
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END; $$
LANGUAGE plpgsql;                               --the function uses PL/pgSQL [PostgreSQL procedural language]

CREATE TRIGGER files_updated_at                 --set a trigger
BEFORE UPDATE ON files                          --when should it fire?
FOR EACH ROW                                    --for each UPDATED row, not all of them
EXECUTE FUNCTION update_updated_at();           --run 'update_updated_at' when the trigger fires

--The body of the function: -> doesn't want coments between &&
--RETURNS TRIGGER AS $$                           --$$ is a string delimiter
--BEGIN                                           --start function body
--    NEW.updated_at = NOW();                     --set the 'updated_at' column of the row being updated to NOW()
--    RETURN NEW;                                 --return the modified row so the update can continue
--END; $$                                         --end of function body
