import {app} from './app'

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

app.listen(port, '0.0.0.0', () => { //port is where clients connect, 0000 listens to all networks
  console.log(`Server running on port ${port}`)
})