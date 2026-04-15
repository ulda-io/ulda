export default class DbAdapterContract {
  async create(_record) {
    throw new Error('create() not implemented');
  }

  async read(_id) {
    throw new Error('read() not implemented');
  }

  async updateChecked(_payload) {
    throw new Error('updateChecked() not implemented');
  }

  async deleteChecked(_payload) {
    throw new Error('deleteChecked() not implemented');
  }
}
