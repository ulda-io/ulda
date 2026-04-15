/**
 * Reference DB adapter contract for UldaServerCRUD.
 *
 * Expected table schema in a SQL store:
 *   id          bigint primary key / auto increment
 *   sign        bytes / blob / bytea
 *   data        bytes / blob / bytea
 *   create_time timestamp
 *   update_time timestamp
 */
export default class DbAdapterContract {
  async create(_record) {
    throw new Error('DbAdapterContract.create(record) is not implemented');
  }

  async read(_id) {
    throw new Error('DbAdapterContract.read(id) is not implemented');
  }

  async updateChecked(_payload) {
    throw new Error('DbAdapterContract.updateChecked(payload) is not implemented');
  }

  async deleteChecked(_payload) {
    throw new Error('DbAdapterContract.deleteChecked(payload) is not implemented');
  }
}
